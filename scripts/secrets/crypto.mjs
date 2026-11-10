/**
 * Vault cryptography (spec §14). Pure Web Crypto, no Foundry globals, so it runs unchanged in the
 * browser and under `node --test`.
 *
 * Why encryption at all: Foundry v14 sends every world document (journals, settings, chat) to
 * every client at load, does not permission-check compendium `get` requests, and broadcasts
 * every document change to every client. Nothing stored on the server is private, so the only
 * secret is one the server never sees in plaintext.
 *
 * Layout:
 * - A random 256-bit AES-GCM *data key* encrypts the vault.
 * - The *keyring* says how to get the data key back:
 *     mode "passphrase": the data key is wrapped with a PBKDF2-derived key. Real secrecy, as
 *                        long as the passphrase resists offline guessing (players do receive
 *                        the keyring and ciphertext).
 *     mode "open":       the data key is stored raw. Stops casual peeking only; anyone with
 *                        dev tools can decrypt. Exists so tables can skip the passphrase.
 * - Every keyring change (setup, new passphrase, mode switch) generates a fresh data key and
 *   re-encrypts, so an old key or passphrase never opens future vault versions.
 * - Plaintext is length-framed and zero-padded to a power-of-two bucket (minimum 16 KiB) so the
 *   ciphertext size reveals only a coarse order of magnitude, not how much was hidden.
 */

export const VAULT_FORMAT = 1;
export const PBKDF2_ITERATIONS = 600000;
export const MIN_BUCKET_BYTES = 16 * 1024;

const subtle = () => globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function randomKeyId() {
  return toBase64(randomBytes(9)).replace(/[+/=]/g, "x");
}

/** Smallest power of two that fits `length`, never below MIN_BUCKET_BYTES. */
export function bucketSize(length) {
  let size = MIN_BUCKET_BYTES;
  while (size < length) size *= 2;
  return size;
}

export function pad(plainBytes) {
  const framed = new Uint8Array(bucketSize(plainBytes.length + 4));
  new DataView(framed.buffer).setUint32(0, plainBytes.length);
  framed.set(plainBytes, 4);
  return framed;
}

export function unpad(framed) {
  const length = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(0);
  if (length > framed.length - 4) throw new Error("Journalinator: corrupt vault padding");
  return framed.subarray(4, 4 + length);
}

export async function generateDataKey() {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportRawKey(key) {
  return toBase64(await subtle().exportKey("raw", key));
}

export async function importRawKey(b64) {
  return subtle().importKey("raw", fromBase64(b64), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

async function deriveWrappingKey(passphrase, salt, iterations) {
  const material = await subtle().importKey("raw", encoder.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function aad(worldId, purpose) {
  return encoder.encode(`journalinator:${purpose}:v${VAULT_FORMAT}:${worldId}`);
}

/**
 * Builds a keyring for a data key. `passphrase` is required for mode "passphrase".
 * `iterations` is overridable only so tests run quickly.
 */
export async function createKeyring(dataKey, { mode, passphrase, worldId, iterations = PBKDF2_ITERATIONS }) {
  const keyId = randomKeyId();
  const raw = await subtle().exportKey("raw", dataKey);
  if (mode === "open") {
    return { v: VAULT_FORMAT, mode: "open", keyId, raw: toBase64(raw) };
  }
  if (mode !== "passphrase") throw new Error(`Journalinator: unknown key mode "${mode}"`);
  if (typeof passphrase !== "string" || !passphrase.length) throw new Error("Journalinator: a passphrase is required");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const wrappingKey = await deriveWrappingKey(passphrase, salt, iterations);
  const wrapped = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: aad(worldId, `key:${keyId}`) }, wrappingKey, raw
  );
  return {
    v: VAULT_FORMAT, mode: "passphrase", keyId,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) },
    iv: toBase64(iv),
    wrapped: toBase64(wrapped)
  };
}

/** Recovers the data key. Throws on a wrong passphrase (AES-GCM authentication fails). */
export async function openKeyring(keyring, { passphrase, worldId } = {}) {
  if (!keyring || keyring.v !== VAULT_FORMAT) throw new Error("Journalinator: unsupported keyring");
  if (keyring.mode === "open") return importRawKey(keyring.raw);
  if (keyring.mode !== "passphrase") throw new Error("Journalinator: unknown key mode");
  if (typeof passphrase !== "string") throw new Error("Journalinator: passphrase required");
  const wrappingKey = await deriveWrappingKey(passphrase, fromBase64(keyring.kdf.salt), keyring.kdf.iterations);
  let raw;
  try {
    raw = await subtle().decrypt(
      { name: "AES-GCM", iv: fromBase64(keyring.iv), additionalData: aad(worldId, `key:${keyring.keyId}`) },
      wrappingKey, fromBase64(keyring.wrapped)
    );
  } catch {
    throw new Error("Journalinator: wrong passphrase");
  }
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

export async function encryptVault(data, dataKey, { keyId, worldId }) {
  const iv = randomBytes(12);
  const framed = pad(encoder.encode(JSON.stringify(data)));
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad(worldId, `vault:${keyId}`) }, dataKey, framed);
  return { v: VAULT_FORMAT, keyId, iv: toBase64(iv), ct: toBase64(ct) };
}

export async function decryptVault(blob, dataKey, { worldId }) {
  if (!blob || blob.v !== VAULT_FORMAT) throw new Error("Journalinator: unsupported vault format");
  const framed = await subtle().decrypt(
    { name: "AES-GCM", iv: fromBase64(blob.iv), additionalData: aad(worldId, `vault:${blob.keyId}`) },
    dataKey, fromBase64(blob.ct)
  );
  return JSON.parse(decoder.decode(unpad(new Uint8Array(framed))));
}
