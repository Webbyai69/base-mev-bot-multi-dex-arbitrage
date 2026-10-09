/**
 * `node dist/main.js new-wallet` (src/wallet.ts) and the BOT_ADDRESS / PRIVATE_KEY
 * consistency check: the key goes straight into .env and is never printed, an
 * existing key is never replaced, and the rest of .env is left exactly as it was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { addBotWalletToEnv } from "../dist/wallet.js";
import { loadSettings } from "../dist/config.js";

const tmpEnv = (text) => {
  const f = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
  if (text !== null) writeFileSync(f, text);
  return f;
};

test("new-wallet fills an empty PRIVATE_KEY line, keeps CRLF and every other line", () => {
  const before = ["# ---- Base RPC", "RPC_URL=https://example.invalid/v2/secret", "MODE=paper", "PRIVATE_KEY=", "MAX_DAILY_GAS_USD=1", ""].join("\r\n");
  const f = tmpEnv(before);
  const r = addBotWalletToEnv(f);
  assert.equal(r.created, true);
  const after = readFileSync(f, "utf8");
  const lines = after.split("\r\n");
  assert.equal(lines.length, 6, "same number of lines, still CRLF");
  const key = lines[3].slice("PRIVATE_KEY=".length);
  assert.match(key, /^0x[0-9a-f]{64}$/);
  assert.equal(new Wallet(key).address, r.address, "the printed address belongs to the saved key");
  assert.equal(after.replace(/PRIVATE_KEY=0x[0-9a-f]{64}/, "PRIVATE_KEY="), before, "nothing else changed");
});

test("new-wallet never replaces an existing key", () => {
  const existing = Wallet.createRandom();
  const before = `MODE=paper\nPRIVATE_KEY=${existing.privateKey}\n`;
  const f = tmpEnv(before);
  const r = addBotWalletToEnv(f);
  assert.equal(r.created, false);
  assert.equal(r.address, existing.address);
  assert.match(r.reason, /already set/);
  assert.equal(readFileSync(f, "utf8"), before);
});

test("new-wallet appends the line when there isn't one, and fixes a BOT_ADDRESS for another wallet", () => {
  const f = tmpEnv("MODE=paper\nBOT_ADDRESS=0x1111111111111111111111111111111111111111");
  const r = addBotWalletToEnv(f);
  assert.equal(r.created, true);
  assert.equal(r.botAddressUpdated, true);
  const text = readFileSync(f, "utf8");
  assert.ok(text.includes(`BOT_ADDRESS=${r.address}`));
  assert.match(text, /\nPRIVATE_KEY=0x[0-9a-f]{64}\n$/);
  // And with no .env at all, it creates one.
  const g = tmpEnv(null);
  assert.equal(addBotWalletToEnv(g).created, true);
  assert.match(readFileSync(g, "utf8"), /^PRIVATE_KEY=0x[0-9a-f]{64}\n$/);
});

test("settings refuse a BOT_ADDRESS that isn't PRIVATE_KEY's address (the dashboard would fund the wrong wallet)", () => {
  const keep = { ...process.env };
  try {
    const w = Wallet.createRandom();
    process.env.PRIVATE_KEY = w.privateKey;
    process.env.BOT_ADDRESS = "0x1111111111111111111111111111111111111111";
    assert.throws(() => loadSettings(), (e) => /BOT_ADDRESS is not the address of PRIVATE_KEY/.test(e.message) && !e.message.includes(w.privateKey.slice(2)));
    process.env.BOT_ADDRESS = w.address;
    assert.doesNotThrow(() => loadSettings());
    process.env.MODE = "live";
    process.env.EXECUTOR_ADDRESS = "";
    assert.throws(() => loadSettings(), /EXECUTOR_ADDRESS/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});
