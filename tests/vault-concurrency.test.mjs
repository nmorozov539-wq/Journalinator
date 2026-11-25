import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";

const gmUser = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const env = installFoundry({ user: gmUser, users: [gmUser] });
await makeContainers(env);

const { VaultStore } = await import("../scripts/secrets/vault-store.mjs");

const label = text => ({ text, x: 0, y: 0, size: 14, color: "" });

test("two GM vault clients cannot silently clobber each other's changes", async () => {
  const first = new VaultStore();
  await first.init();
  await first.setKeyring({ mode: "open" });

  const second = new VaultStore();
  await second.init();
  assert.equal(second.status, "unlocked", "open keyrings unlock without a passphrase");

  await Promise.all([
    first.mutate(vault => { vault.labels.first = label("first"); }),
    second.mutate(vault => { vault.labels.second = label("second"); })
  ]);

  const reader = new VaultStore();
  await reader.init();
  assert.ok(reader.data.labels.first, "the first GM's change survived");
  assert.ok(reader.data.labels.second, "the second GM's change survived");
});
