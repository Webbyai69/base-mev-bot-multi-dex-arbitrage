/**
 * scripts/carry-over.mjs: moving .env, the bot wallet and the bot's memory
 * from an old install into a fresh copy. Uses temporary folders, a public
 * Hardhat development key and a fake RPC; needs no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, plan, readEnv } from "../scripts/carry-over.mjs";

// Hardhat/Anvil account #0: a public development key, never funded on Base.
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEV_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat #1
const OTHER_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RPC = "https://base-mainnet.example/v2/SuperSecretKey123";

const derive = async (pk) => ({ [DEV_KEY]: DEV_ADDR, [OTHER_KEY]: OTHER_ADDR })[pk.toLowerCase()] ?? (() => { throw new Error("bad key"); })();
const fakeRpc = async (url, init) => {
  const { method } = JSON.parse(init.body);
  return { json: async () => ({ jsonrpc: "2.0", id: 1, result: method === "eth_chainId" ? "0x2105" : "0x" + (19n * 10n ** 15n).toString(16) }) };
};

function oldInstall({ env = `RPC_URL=${RPC}\nMODE=live\nPRIVATE_KEY=${DEV_KEY}\nROUTE_EXECUTOR_ADDRESS=0x7777777777777777777777777777777777777777\n` } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "carry-old-"));
  writeFileSync(join(dir, ".env"), env);
  mkdirSync(join(dir, "data", "fleet"), { recursive: true });
  writeFileSync(join(dir, "data", ".gitkeep"), "");
  writeFileSync(join(dir, "data", "learned.json"), '{"routes":{"a":1}}');
  writeFileSync(join(dir, "data", "pools.json"), '{"pools":[1,2,3]}');
  writeFileSync(join(dir, "data", "STOP"), "stopped: 5 failed sends\n");
  writeFileSync(join(dir, "data", "fleet", "morpho.heartbeat.json"), "{}");
  // Old enough not to look like a running bot.
  const old = new Date(Date.now() - 3600_000);
  for (const f of ["learned.json", "pools.json", "STOP"]) utimesSync(join(dir, "data", f), old, old);
  utimesSync(join(dir, "data", "fleet", "morpho.heartbeat.json"), old, old);
  return dir;
}
const freshClone = () => {
  const dir = mkdtempSync(join(tmpdir(), "carry-new-"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "data", ".gitkeep"), "");
  return dir;
};
const run = async (args) => {
  const lines = [];
  const code = await main(args, { log: (l) => lines.push(String(l)), deriveAddress: derive, fetchImpl: fakeRpc });
  return { code, out: lines.join("\n") };
};

test("carries .env and the bot's memory into a fresh copy and confirms the same funded wallet", async () => {
  const from = oldInstall();
  const to = freshClone();
  const { code, out } = await run(["--from", from, "--to", to]);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(to, ".env"), "utf8"), readFileSync(join(from, ".env"), "utf8"));
  for (const f of ["learned.json", "pools.json", "STOP", join("fleet", "morpho.heartbeat.json")]) assert.ok(existsSync(join(to, "data", f)), f);
  assert.match(out, new RegExp(`Bot wallet \\(old folder\\): ${DEV_ADDR}`));
  assert.match(out, new RegExp(`Bot wallet \\(this folder\\): ${DEV_ADDR}  same wallet`));
  assert.match(out, /ROUTE_EXECUTOR_ADDRESS\s+0x7777…7777 carried over/);
  assert.match(out, /Gas money in the bot wallet: 0\.019000 ETH on Base/);
  assert.match(out, /data\\STOP came across too/);
  assert.match(out, /one live copy/);
  // Nothing secret is ever printed.
  assert.ok(!out.includes(DEV_KEY.slice(2)), "the key");
  assert.ok(!out.includes("SuperSecretKey123"), "the RPC URL");
  // A second run finds everything already there.
  const again = await run(["--from", from, "--to", to]);
  assert.equal(again.code, 0);
  assert.match(again.out, /already here/);
  assert.doesNotMatch(again.out, /to copy/);
});

test("never overwrites without --force, and keeps a backup when it does", async () => {
  const from = oldInstall();
  const to = freshClone();
  writeFileSync(join(to, "data", "learned.json"), '{"routes":{}}'); // a new install's first, empty memory
  const kept = await run(["--from", from, "--to", to]);
  assert.equal(readFileSync(join(to, "data", "learned.json"), "utf8"), '{"routes":{}}');
  assert.match(kept.out, /different here, kept \(use --force\)/);
  const forced = await run(["--from", from, "--to", to, "--force"]);
  assert.equal(forced.code, 0);
  assert.equal(readFileSync(join(to, "data", "learned.json"), "utf8"), '{"routes":{"a":1}}');
  assert.ok(readdirSync(join(to, "data")).some((f) => /^learned\.json\.\d{8}-\d{6}\.bak$/.test(f)), "backup kept");
});

test("says so when this folder has a different bot wallet", async () => {
  const from = oldInstall();
  const to = freshClone();
  writeFileSync(join(to, ".env"), `RPC_URL=${RPC}\nPRIVATE_KEY=${OTHER_KEY}\n`);
  const { code, out } = await run(["--from", from, "--to", to]);
  assert.equal(code, 1);
  assert.match(out, /DIFFERENT wallet/);
  assert.match(out, /\.env among them/);
  assert.ok(!out.includes(OTHER_KEY.slice(2)));
});

test("a dry run copies nothing; bad folders are refused", async () => {
  const from = oldInstall();
  const to = freshClone();
  const { code, out } = await run(["--from", from, "--to", to, "--dry-run"]);
  assert.equal(code, 0);
  assert.match(out, /dry run/);
  assert.ok(!existsSync(join(to, ".env")));
  assert.ok(!existsSync(join(to, "data", "learned.json")));
  await assert.rejects(run(["--from", to, "--to", to]), /nothing to carry over/);
  await assert.rejects(run(["--from", join(to, "nope"), "--to", to]), /no folder/);
  await assert.rejects(run(["--from", mkdtempSync(join(tmpdir(), "carry-empty-")), "--to", to]), /no \.env and no data/);
  await assert.rejects(run(["--from", from, "--bogus"]), /unknown option/);
});

test("an encrypted key store travels with data/, and a running old bot is flagged", async () => {
  const from = oldInstall({ env: `RPC_URL=${RPC}\nKEYSTORE_FILE=./data/keystore.json\n` });
  writeFileSync(join(from, "data", "keystore.json"), '{"version":3,"crypto":{}}');
  const to = freshClone();
  const { code, out } = await run(["--from", from, "--to", to]);
  assert.equal(code, 0);
  assert.ok(existsSync(join(to, "data", "keystore.json")));
  assert.match(out, /keeps the bot key encrypted/);
  assert.match(out, /still running/, "keystore.json was just written");
});

test("a part's settings file stays behind when this copy doesn't have that part", async () => {
  const from = oldInstall();
  mkdirSync(join(from, "qortal", "bridge"), { recursive: true });
  writeFileSync(join(from, "qortal", "bridge", "bridge.env"), "# bridge settings\n");
  const to = freshClone();
  const { code, out } = await run(["--from", from, "--to", to]);
  assert.equal(code, 0);
  assert.ok(!existsSync(join(to, "qortal", "bridge", "bridge.env")), "not copied into a copy without the bridge");
  assert.match(out, /qortal\/bridge\/bridge\.env\s+left in the old folder: this copy has no qortal\/bridge folder/);
  mkdirSync(join(to, "qortal", "bridge"), { recursive: true });
  await run(["--from", from, "--to", to]);
  assert.ok(existsSync(join(to, "qortal", "bridge", "bridge.env")), "copied once the bridge is here");
});

test("plan and readEnv follow the bot's own .env rules", () => {
  const from = oldInstall({ env: `# comment\nPRIVATE_KEY="${DEV_KEY}"\nEMPTY=\n` });
  assert.deepEqual(readEnv(join(from, ".env")), { PRIVATE_KEY: DEV_KEY, EMPTY: "" });
  const rows = plan(from, freshClone());
  assert.ok(rows.some((r) => r.rel === ".env" && r.action === "copy"));
  assert.ok(!rows.some((r) => r.rel.endsWith(".gitkeep")));
  assert.ok(rows.some((r) => r.rel === "bots/wrapper/.env" && r.action === "absent"));
});
