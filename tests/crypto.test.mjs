import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateDataKey, createKeyring, openKeyring, encryptVault, decryptVault,
  bucketSize, pad, unpad, MIN_BUCKET_BYTES, exportRawKey
} from "../scripts/secrets/crypto.mjs";

const worldId = "test-world";
const fast = { iterations: 1000 };

test("passphrase keyring round-trips and rejects a wrong passphrase", async () => {
  const key = await generateDataKey();
  const ring = await createKeyring(key, { mode: "passphrase", passphrase: "correct horse", worldId, ...fast });
  assert.equal(ring.mode, "passphrase");
  assert.equal(ring.raw, undefined, "passphrase keyring must not contain the raw key");
  const opened = await openKeyring(ring, { passphrase: "correct horse", worldId });
  assert.equal(await exportRawKey(opened), await exportRawKey(key));
  await assert.rejects(openKeyring(ring, { passphrase: "wrong", worldId }), /wrong passphrase/);
});

test("keyring is bound to its world", async () => {
  const key = await generateDataKey();
  const ring = await createKeyring(key, { mode: "passphrase", passphrase: "pw", worldId, ...fast });
  await assert.rejects(openKeyring(ring, { passphrase: "pw", worldId: "other-world" }));
});

test("open keyring needs no passphrase", async () => {
  const key = await generateDataKey();
  const ring = await createKeyring(key, { mode: "open", worldId });
  const opened = await openKeyring(ring, { worldId });
  assert.equal(await exportRawKey(opened), await exportRawKey(key));
});

test("vault round-trips and does not contain plaintext", async () => {
  const key = await generateDataKey();
  const data = { notes: { a: { name: "GM-AAAA Lord Vex", blocks: [{ text: "He is the traitor" }] } } };
  const blob = await encryptVault(data, key, { keyId: "k1", worldId });
  // Check the raw ciphertext bytes rather than base64: a short string like "Vex" can appear in
  // ~20k characters of random base64 by chance.
  const raw = Buffer.from(blob.ct, "base64").toString("latin1");
  assert.ok(!raw.includes("He is the traitor"));
  assert.ok(!raw.includes("GM-AAAA Lord Vex"));
  assert.deepEqual(await decryptVault(blob, key, { worldId }), data);
});

test("tampered or wrong-key vault fails to decrypt", async () => {
  const key = await generateDataKey();
  const other = await generateDataKey();
  const blob = await encryptVault({ x: 1 }, key, { keyId: "k1", worldId });
  await assert.rejects(decryptVault(blob, other, { worldId }));
  await assert.rejects(decryptVault({ ...blob, keyId: "k2" }, key, { worldId }), "keyId is authenticated");
});

test("ciphertext size does not reveal small differences in hidden volume", async () => {
  const key = await generateDataKey();
  const small = await encryptVault({ text: "a" }, key, { keyId: "k", worldId });
  const larger = await encryptVault({ text: "a".repeat(10000) }, key, { keyId: "k", worldId });
  assert.equal(small.ct.length, larger.ct.length);
});

test("padding buckets are powers of two with a floor", () => {
  assert.equal(bucketSize(1), MIN_BUCKET_BYTES);
  assert.equal(bucketSize(MIN_BUCKET_BYTES), MIN_BUCKET_BYTES);
  assert.equal(bucketSize(MIN_BUCKET_BYTES + 1), MIN_BUCKET_BYTES * 2);
  const bytes = new TextEncoder().encode("hello");
  assert.deepEqual([...unpad(pad(bytes))], [...bytes]);
});
