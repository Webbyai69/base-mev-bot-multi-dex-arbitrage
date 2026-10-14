/**
 * tools/night-watch/night_watch.mjs: the read-only report the overnight learning
 * agent runs. Checks it reads a fixture bot folder correctly, records history
 * only where it is told to, and never writes inside the bot folder.
 * Needs the compiled dist/ (it uses dist/command for the terminal's maths).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "tools", "night-watch", "night_watch.mjs");

const SELF = "0x000000000000000000000000000000000000beef";
const RIVAL = "0x5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed";
const POOL_A = "0x2df380544b88adb3ad0a94100dcc45fd705aae2d";
const POOL_B = "0x1ef035205f94c7734827961c438474d089a334a0";
const POOL_X = "0x9999999999999999999999999999999999999999";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TAKEN_TX = "0x" + "ab".repeat(32);

const logTime = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function fixtureBot() {
  const dir = mkdtempSync(join(tmpdir(), "night-watch-"));
  const bot = join(dir, "base-arb-bot");
  const watch = join(dir, "base-arb-watch");
  mkdirSync(join(bot, "data"), { recursive: true });
  mkdirSync(join(bot, "reports"), { recursive: true });
  mkdirSync(watch, { recursive: true });
  // A junction works on Windows without admin rights; elsewhere the type is ignored.
  symlinkSync(join(ROOT, "dist"), join(bot, "dist"), "junction");
  const now = Date.now();
  const found = new Date(now - 20 * 60_000).toISOString();
  const id = "100-fb-test";
  writeFileSync(
    join(bot, "data", "opportunities.jsonl"),
    jsonl([
      { kind: "opportunity", id, block: 100, foundAt: found, pairSymbols: "USDC>XDP>USDC", buyPool: POOL_A, buyDex: "uniswap-v3", sellPool: POOL_B, sellDex: "slipstream-v3", profitUsd: 2.4, gasUsd: 0.01, netUsd: 2.39, sim: "executor-ok", hops: 2, stage: "flashblock", msIntoBlock: 868, route: { dexes: ["uniswap-v3", "slipstream-v3"], pools: [POOL_A, POOL_B] } },
      { kind: "outcome", id, block: 100, finalizedAt: found, status: "taken", realisticNetUsd: 0, takenBy: RIVAL, takenTx: TAKEN_TX, takenBlock: 102 },
    ]),
  );
  writeFileSync(
    join(bot, "data", "live.jsonl"),
    jsonl([
      { kind: "live", id, block: 100, sentAt: found, status: "pending", priorityFeeGwei: 0.367, expectedProfitUsd: 2.36, route: true },
      { kind: "live", id, block: 100, sentAt: found, status: "reverted", priorityFeeGwei: 0.367, expectedProfitUsd: 2.36, route: true, gasUsd: 0.415, minedBlock: 102 },
    ]),
  );
  const ts = new Date(now - 10 * 60_000).toISOString();
  writeFileSync(
    join(bot, "data", "mev.jsonl"),
    jsonl([
      { kind: "mev", type: "arbitrage", block: 102, timestamp: ts, txHash: TAKEN_TX, txIndex: 128, sender: "0x1111111111111111111111111111111111111111", bot: RIVAL, pools: [POOL_A, POOL_X], dexes: ["uniswap-v3", "unknown-v3"], tokens: [USDC, "0x07b3d902783c3c12b077508c3b5c00113d1291d0"], profitUsd: 5, priorityGwei: 0.003 },
      // Our own trade must never count as a rival's.
      { kind: "mev", type: "arbitrage", block: 103, timestamp: ts, txHash: "0x" + "cd".repeat(32), txIndex: 3, sender: SELF, bot: SELF, pools: [POOL_A, POOL_B], dexes: ["uniswap-v3"], tokens: [USDC], profitUsd: 1, priorityGwei: 0.5 },
      { kind: "mev", type: "sandwich", block: 104, timestamp: ts, txHash: "0x" + "ef".repeat(32), txIndex: 9, sender: "0x2222222222222222222222222222222222222222", bot: "0x2222222222222222222222222222222222222222", pools: [POOL_A], dexes: ["uniswap-v3"], tokens: [USDC], profitUsd: 40 },
    ]),
  );
  writeFileSync(
    join(bot, "data", "pools.json"),
    JSON.stringify({ version: 1, discoveredAt: "2026-10-10T20:15:17.210Z", block: 90, tokens: [{ address: USDC, symbol: "USDC", decimals: 6 }], pools: [{ address: POOL_A, dex: "uniswap-v3" }, { address: POOL_B, dex: "slipstream-v3" }] }),
  );
  const log = [
    `${logTime(now - 30 * 60_000)} INFO  block 90: 2000 pools, 0 opps, 0 mev txs, 1500ms, gas/tx $0.0065, flashblocks 10 scans/1 opps, 5 borrowers, rpc 100 calls (~8.5M Alchemy CU/day at this pace), uptime 5m`,
    `${logTime(now - 20 * 60_000)} INFO  block 100: 2000 pools, 1 opps, 0 mev txs, 2500ms, gas/tx $0.0065, flashblocks 20 scans/1 opps, 5 borrowers, rpc 200 calls (~8.6M Alchemy CU/day at this pace), uptime 15m`,
    `${logTime(now - 19 * 60_000)} WARN  RPC request failed, retrying: 429 Too Many Requests`,
    `${logTime(now - 18 * 60_000)} WARN  RPC request failed, retrying: 429 Too Many Requests`,
  ].join("\n");
  writeFileSync(join(bot, "reports", "run-2026-10-11_1417.log"), log + "\n");
  writeFileSync(join(bot, "reports", "run-2026-10-11_1417.err.log"), `${logTime(now - 31 * 60_000)} WARN  LIVE: setup checks out (bot wallet ${SELF}, 0.00899 ETH for gas); sending enabled\n`);
  writeFileSync(join(bot, "reports", "run-24h.status.txt"), "bot pid 1 started 2026-10-11T14:17:20, stops after 24 h\n");
  writeFileSync(
    join(bot, "reports", "digest-latest.md"),
    [
      `Generated ${new Date(now - 5 * 60_000).toISOString()} · mode **live** · 2000 pools watched.`,
      "",
      "## Live trading",
      "Sending enabled. Gas today $0.415 of the $1.00 daily limit; failed sends in a row 1 of 5.",
      "",
      "| code | stage | count | % of candidates |",
      "|---|---|---|---|",
      "| NET_NEGATIVE_AFTER_GAS | gas cost more than the spread | 731 | 92.649% |",
      "",
      "## Settings changed on the dashboard",
      "maxBidShare = 0.1 (.env: 0.3); blocked tokens: HERO.",
      "",
    ].join("\n"),
  );
  return { bot, watch };
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** Every file and folder under dir, without following the dist link. */
function listing(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + e.name;
    out.push(rel);
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...listing(join(dir, e.name), rel + "/"));
  }
  return out.sort();
}

test("night watch: reads the bot's records and never writes inside the bot folder", () => {
  const { bot, watch } = fixtureBot();
  const before = listing(bot);
  const out = run(["--hours", "3", "--record"], { BOT_DIR: bot, WATCH_DIR: watch });
  assert.deepEqual(listing(bot), before, "the bot folder is untouched");

  assert.match(out, /\*\*running\*\*/);
  assert.match(out, /failed sends in a row 1 of 5/);
  assert.match(out, /Dashboard changes in force: maxBidShare = 0\.1/);
  // The lost race: who won, what they bid, and found → mined.
  assert.match(out, /USDC>XDP>USDC \[uniswap-v3>slipstream-v3\] \| \$2\.36 \| 0\.367 \| 100 → 102 \(\+2\) \| 0x5eed5eed \| 0\.003 \| 128/);
  // Repeated warnings are grouped; the startup banner is counted, not listed.
  assert.match(out, /\| WARN \| 2 \|.*429 Too Many Requests/);
  assert.match(out, /bot starts 1/);
  assert.doesNotMatch(out, /\| WARN \|[^\n]*setup checks out/);
  // Rivals: our own trade is excluded; coverage and unknown venues are split out.
  assert.match(out, /1 arbitrage trades by 1 bots, \$5\.00 in total/);
  assert.match(out, /\$5\.00 on routes we partly watch/);
  assert.match(out, /\$5\.00 went through a DEX the bot can't name yet/);
  assert.match(out, /Sandwiches seen: 1/);
  assert.match(out, /PancakeSwap V3 pools: 0, Uniswap V4 pools: 0/);
  assert.match(out, /NET_NEGATIVE_AFTER_GAS \| 731 \| 92\.649%/);

  const hist = readFileSync(join(watch, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(hist.length, 1);
  assert.equal(hist[0].alive, true);
  assert.equal(hist[0].live.reverted, 1);
  assert.equal(hist[0].rivals.arbs, 1);
  assert.equal(hist[0].rivals.unknownVenueUsd, 5);
  assert.equal(hist[0].blocks.n, 2);
  assert.equal(hist[0].blocks.over2s, 1);
  assert.equal(hist[0].failsInRow, 1);

  // A second run shows the trend from the first.
  const again = run(["--hours", "3"], { BOT_DIR: bot, WATCH_DIR: watch });
  assert.match(again, /## Trend/);
  assert.equal(readFileSync(join(watch, "history.jsonl"), "utf8").trim().split("\n").length, 1, "no --record, no new line");
});

test("night watch: the simulator replays recorded finds with the terminal's maths", () => {
  const { bot, watch } = fixtureBot();
  const out = run(["--simulate", '{"minProfitUsd":0.1,"gasX":0.5,"latencyCutMs":300,"hours":24}'], { BOT_DIR: bot, WATCH_DIR: watch });
  const json = JSON.parse(out.slice(0, out.lastIndexOf("}") + 1));
  assert.equal(json.finds, 1);
  assert.equal(json.result.config.gasX, 0.5);
  assert.equal(json.baseline.config.gasX, 1);
  assert.ok(json.result.wonBackUsd >= json.baseline.wonBackUsd, "a latency cut can only win races back");
  assert.match(out, /Modelled replay/);
});

test("night watch: a stopped bot is reported as stopped", () => {
  const { bot, watch } = fixtureBot();
  // Logs last written an hour ago: the bot has gone quiet.
  const old = new Date(Date.now() - 60 * 60_000);
  for (const f of readdirSync(join(bot, "reports")).filter((x) => x.endsWith(".log"))) utimesSync(join(bot, "reports", f), old, old);
  const out = run(["--hours", "3"], { BOT_DIR: bot, WATCH_DIR: watch });
  assert.match(out, /LOOKS STOPPED/);
});
