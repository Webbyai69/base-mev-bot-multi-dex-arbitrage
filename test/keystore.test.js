/**
 * Encrypted operator-key store (src/keystore.ts): encrypt a key into a scrypt keystore and load it
 * back into process.env.PRIVATE_KEY at boot, with no silent plaintext fallback. The owner/operator
 * contract model is the real protection; this just stops the raw key living in plaintext at rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { encryptWalletToKeystore, loadKeystoreIntoEnv } from "../dist/keystore.js";

const N = 1 << 10; // low scrypt work factor so the test is fast; production uses ethers' strong default

test("keystore round-trip: encrypt a key, load it back into PRIVATE_KEY", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ks-")), "keystore.json");
  const w = Wallet.createRandom();

  const r = await encryptWalletToKeystore({ privateKey: w.privateKey, path, passphrase: "correct horse battery", scryptN: N });
  assert.equal(r.address, w.address);
  assert.equal(r.createdKey, false, "used the supplied key, did not generate one");
  assert.ok(existsSync(path), "keystore file written");

  delete process.env.PRIVATE_KEY;
  const ok = await loadKeystoreIntoEnv({ keystoreFile: path, passphrase: "correct horse battery" });
  assert.equal(ok, true);
  assert.equal(process.env.PRIVATE_KEY, w.privateKey, "the right key is injected into the environment");
  delete process.env.PRIVATE_KEY;
});

test("a wrong passphrase is rejected and never yields a key", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ks-")), "keystore.json");
  const w = Wallet.createRandom();
  await encryptWalletToKeystore({ privateKey: w.privateKey, path, passphrase: "right", scryptN: N });
  delete process.env.PRIVATE_KEY;
  await assert.rejects(() => loadKeystoreIntoEnv({ keystoreFile: path, passphrase: "wrong" }));
  assert.equal(process.env.PRIVATE_KEY, undefined, "no key leaks on a bad passphrase");
});

test("generates a fresh key when none is present, and refuses to overwrite without --force", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ks-")), "keystore.json");
  const saved = process.env.PRIVATE_KEY;
  delete process.env.PRIVATE_KEY;
  const r = await encryptWalletToKeystore({ path, passphrase: "a passphrase", scryptN: N });
  assert.equal(r.createdKey, true, "generated a key because none was supplied or in the environment");
  assert.match(r.address, /^0x[0-9a-fA-F]{40}$/);
  await assert.rejects(() => encryptWalletToKeystore({ path, passphrase: "a passphrase", scryptN: N }), /already exists/);
  // --force overwrites.
  const r2 = await encryptWalletToKeystore({ path, passphrase: "a passphrase", scryptN: N, overwrite: true });
  assert.match(r2.address, /^0x[0-9a-fA-F]{40}$/);
  if (saved !== undefined) process.env.PRIVATE_KEY = saved;
});

test("a missing keystore file is a hard error, not a silent fallback", async () => {
  await assert.rejects(() => loadKeystoreIntoEnv({ keystoreFile: join(tmpdir(), "does-not-exist-" + Date.now() + ".json"), passphrase: "x" }), /no keystore was found/);
});
