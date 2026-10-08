import { fileURLToPath } from "node:url";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { baseScenario } from "./mockchain.mjs";
import { Chain } from "../dist/rpc.js";
import { PoolRegistry } from "../dist/pools.js";
import { Scanner } from "../dist/scanner.js";
import { GasEstimator } from "../dist/gas.js";
import { Store } from "../dist/store.js";
import { PaperEngine, summarize } from "../dist/paper.js";
import { Classifier, marketSummary } from "../dist/classifier.js";
import { renderReport } from "../dist/report.js";
import { runCheck } from "../dist/check.js";
import { setLogLevel } from "../dist/log.js";

setLogLevel("error");
const E18 = 10n ** 18n, E6 = 10n ** 6n;

let scenario, chain, registry, store, dataDir;

before(async () => {
  scenario = baseScenario();
  await scenario.c.listen();
  chain = new Chain(scenario.c.url);
  registry = new PoolRegistry(chain);
  dataDir = mkdtempSync(join(tmpdir(), "arbbot-"));
  store = new Store(dataDir);
});

after(async () => {
  await chain.destroy();
  await scenario.c.close();
});

// The mock chain models the V2-style DEXes only; the upgrade's contracts (Uniswap V3 /
// Slipstream quoters, Morpho, Balancer, Aave) are verified by `check` against real Base.
const V2_ONLY = { clPools: false, flashLoans: false, liquidations: false };

test("check passes against the mock chain", async () => {
  assert.equal(await runCheck(chain, V2_ONLY), true);
});

test("full discovery enumerates the factories", async () => {
  const r = new PoolRegistry(chain);
  await r.discover({ minLiquidityWeth: 2, maxPools: 400, mode: "full" });
  const addrs = [...r.pools.keys()];
  assert.ok(addrs.includes(scenario.aeroWethUsdc.address) && addrs.includes(scenario.uniWethUsdc.address));
  assert.ok(!addrs.includes("0xaaaa000000000000000000000000000000000008"), "stable pool skipped");
});

test("activity discovery finds cross-DEX pools, calibrates fees, filters junk", async () => {
  scenario.c.activityBlock();
  await registry.discover({ minLiquidityWeth: 2, maxPools: 400, mode: "activity", lookbackBlocks: 5, logRange: 2 });
  const pools = [...registry.pools.values()];
  const addrs = pools.map((p) => p.address);
  // WETH/USDC exists on 4 DEXes -> all four watched. MEME/WETH on 2 -> watched.
  assert.ok(addrs.includes(scenario.uniWethUsdc.address), "uniswap pool watched");
  assert.ok(addrs.includes(scenario.sushiWethUsdc.address), "sushi pool watched");
  assert.ok(addrs.includes(scenario.aeroWethUsdc.address), "aerodrome pool watched");
  assert.ok(addrs.includes(scenario.baseswapWethUsdc.address), "baseswap pool watched");
  assert.ok(addrs.includes("0xaaaa000000000000000000000000000000000005"), "meme pool 1 watched");
  // Illiquid DAI/WETH (0.01 WETH) is dropped; stable USDC/DAI is skipped.
  assert.ok(!addrs.includes("0xaaaa000000000000000000000000000000000007"), "illiquid pool dropped");
  assert.ok(!addrs.includes("0xaaaa000000000000000000000000000000000008"), "stable pool skipped");
  // Fee calibration against the DEX quoters.
  assert.equal(registry.pools.get(scenario.baseswapWethUsdc.address).feePpm, 2500);
  assert.equal(registry.pools.get(scenario.uniWethUsdc.address).feePpm, 3000);
  const aero = registry.pools.get(scenario.aeroWethUsdc.address);
  assert.equal(aero.feeModel, "bps");
  assert.equal(aero.feePpm, 3000);
  assert.equal(registry.symbol(scenario.USDC), "USDC");
  assert.equal(registry.token(scenario.USDC).decimals, 6);
  // Snapshot round-trip.
  const snap = registry.toSnapshot(scenario.c.block);
  const r2 = new PoolRegistry(chain);
  r2.loadSnapshot(snap);
  assert.equal(r2.pools.size, registry.pools.size);
});

test("scanner finds the Aerodrome/Uniswap WETH-USDC arbitrage and verifies it with the quoters", async () => {
  const n = scenario.c.block;
  await registry.refreshAll(n);
  const ethUsd = registry.ethPrice();
  assert.ok(ethUsd > 1900 && ethUsd < 2100, `eth price ${ethUsd}`);
  const gas = await new GasEstimator(chain, 260_000, 0.005).quote(n, null);
  assert.ok(gas.l1FeeWei > 0n && gas.l2FeeWei > 0n);
  const scanner = new Scanner(chain, registry, undefined, false); // quoter verification path
  assert.equal(scanner.simMode, "quoter");
  const opps = await scanner.scan(n, gas, ethUsd, 0.01);
  assert.ok(opps.length >= 1, "expected at least one opportunity");
  const top = opps[0];
  assert.equal(top.sim, "quoter-ok", top.simDetail);
  assert.ok([top.buyDex, top.sellDex].includes("aerodrome"), "route uses aerodrome");
  assert.ok(top.netUsd > 10, `net ${top.netUsd}`); // a 5% spread on a $200k pool is worth a lot more than gas
  // Only one route per token pair is kept.
  assert.equal(new Set(opps.map((o) => o.pair)).size, opps.length);
  // MEME/WETH spread (0.1%) is inside the fees -> not present.
  assert.ok(!opps.some((o) => o.pairSymbols.includes("MEME")));
});

test("state-override simulation verifies routes exactly and weeds out fee-on-transfer traps", async () => {
  const sc = baseScenario();
  await sc.c.listen();
  sc.c.activityBlock();
  const c = new Chain(sc.c.url);
  const r = new PoolRegistry(c);
  await r.discover({ minLiquidityWeth: 2, maxPools: 400, mode: "activity", lookbackBlocks: 5, logRange: 2 });
  const gasEst = new GasEstimator(c, 260_000, 0.005);
  const scanner = new Scanner(c, r); // default: override simulation
  assert.equal(scanner.simMode, "override");
  let n = sc.c.block;
  await r.refreshAll(n);
  let opps = await scanner.scan(n, await gasEst.quote(n, null), r.ethPrice(), 0.01);
  assert.equal(opps.length, 1);
  assert.equal(opps[0].sim, "executor-ok", opps[0].simDetail);
  assert.ok(opps[0].simDetail.includes(`on-chain profit ${opps[0].profit}`), "simulated profit equals the local quote");

  // Now make MEME a fee-on-transfer token and open a MEME/WETH spread. Quoters would bless it;
  // the simulation reverts, the route is muted, and after 3 failures the pair is dropped.
  sc.c.feeOnTransfer.add(sc.MEME);
  const memeUni = sc.c.pools.get("0xaaaa000000000000000000000000000000000005");
  memeUni.reserve1 = memeUni.reserve1 + memeUni.reserve1 / 10n; // WETH 10% dearer on uni
  scanner.failureMuteBlocks = 0; // retry every block so the test can count failures
  for (let i = 0; i < 3; i++) {
    n = sc.c.nextBlock();
    await r.refreshAll(n);
    opps = await scanner.scan(n, await gasEst.quote(n, null), r.ethPrice(), 0.01);
    const meme = opps.find((o) => o.pairSymbols.includes("MEME"));
    assert.ok(meme, `MEME route found on attempt ${i + 1}`);
    assert.equal(meme.sim, "executor-revert", meme.simDetail);
  }
  assert.ok(![...r.pools.values()].some((p) => p.token0 === sc.MEME || p.token1 === sc.MEME), "MEME pools dropped after 3 reverts");
  assert.equal(r.dirty, true);
  // Failed-sim opportunities never count towards realistic P&L.
  const store = new Store(mkdtempSync(join(tmpdir(), "arbbot-sim-")));
  const paper = new PaperEngine(store, r);
  paper.onBlock(n, opps.filter((o) => o.pairSymbols.includes("MEME")), [], r.ethPrice());
  n = sc.c.nextBlock(); await r.refreshAll(n); paper.onBlock(n, [], [], r.ethPrice());
  n = sc.c.nextBlock(); await r.refreshAll(n); paper.onBlock(n, [], [], r.ethPrice());
  const sum = await summarize(store);
  assert.equal(sum[0].simMismatches, 1);
  assert.equal(sum[0].realisticNetUsd, 0);
  await c.destroy();
  await sc.c.close();
});

test("classifier detects an arbitrage and a sandwich from Swap logs", async () => {
  const bot = "0xb0b0000000000000000000000000000000000001";
  const searcher = "0x5ea5ea0000000000000000000000000000000001";
  const attacker = "0xa77a000000000000000000000000000000000001";
  const victim = "0x0100000000000000000000000000000000000002";
  const sushi = scenario.sushiWethUsdc.address;
  const n = scenario.c.nextBlock({
    txs: [
      { hash: "0x" + "01".repeat(32), from: searcher, to: bot }, // arbitrage
      { hash: "0x" + "02".repeat(32), from: attacker, to: attacker }, // frontrun
      { hash: "0x" + "03".repeat(32), from: victim, to: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24" }, // victim
      { hash: "0x" + "04".repeat(32), from: attacker, to: attacker }, // backrun
    ],
    swaps: [
      { tx: "0x" + "01".repeat(32), pool: scenario.aeroWethUsdc.address, from: bot, tokenIn: scenario.WETH, amountIn: E18, amountOut: 2090n * E6 },
      { tx: "0x" + "01".repeat(32), pool: scenario.uniWethUsdc.address, from: bot, tokenIn: scenario.USDC, amountIn: 2090n * E6, amountOut: (103n * E18) / 100n },
      { tx: "0x" + "02".repeat(32), pool: sushi, from: attacker, tokenIn: scenario.WETH, amountIn: E18, amountOut: 1990n * E6 },
      { tx: "0x" + "03".repeat(32), pool: sushi, from: victim, tokenIn: scenario.WETH, amountIn: 5n * E18, amountOut: 9800n * E6 },
      { tx: "0x" + "04".repeat(32), pool: sushi, from: attacker, tokenIn: scenario.USDC, amountIn: 1990n * E6, amountOut: (102n * E18) / 100n },
    ],
  });
  const classifier = new Classifier(chain, registry, store);
  const detected = await classifier.classifyBlock(n, 2000);
  const arb = detected.find((d) => d.type === "arbitrage");
  assert.ok(arb, "arbitrage detected");
  assert.equal(arb.bot, bot);
  assert.equal(arb.sender, searcher);
  assert.equal(arb.profitToken, scenario.WETH);
  assert.equal(arb.profitAmount, (3n * E18) / 100n);
  assert.ok(Math.abs(arb.profitUsd - 60) < 1, `profit usd ${arb.profitUsd}`);
  assert.deepEqual([...arb.dexes].sort(), ["aerodrome", "uniswap-v2"]);
  const sw = detected.find((d) => d.type === "sandwich");
  assert.ok(sw, "sandwich detected");
  assert.equal(sw.bot, attacker);
  assert.equal(sw.victimTx, "0x" + "03".repeat(32));
  assert.equal(sw.backrunTx, "0x" + "04".repeat(32));
  assert.equal(sw.profitAmount, (2n * E18) / 100n);
  // Persisted and aggregated.
  const ms = await marketSummary(store, (a) => registry.symbol(a), [bot]);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].arbitrageTxs, 1);
  assert.equal(ms[0].sandwichTxs, 1);
  assert.equal(ms[0].watched[0].bot, bot);
  assert.ok(ms[0].topPairs[0].pair.includes("USDC"));
});

test("paper engine tracks outcomes: taken, persisted, closed", async () => {
  const scanner = new Scanner(chain, registry);
  const gasEst = new GasEstimator(chain, 260_000, 0.005);
  const paper = new PaperEngine(store, registry);
  const classifier = new Classifier(chain, registry, store);

  // Block A: opportunity found.
  let n = scenario.c.nextBlock();
  await registry.refreshAll(n);
  let ethUsd = registry.ethPrice();
  let opps = await scanner.scan(n, await gasEst.quote(n, null), ethUsd, 0.01);
  assert.equal(opps.length, 1);
  const oppA = opps[0];
  paper.onBlock(n, opps, [], ethUsd);

  // Block A+1: a bot arbs the same pools -> "taken".
  const bot = "0xb0b0000000000000000000000000000000000002";
  n = scenario.c.nextBlock({
    txs: [{ hash: "0x" + "11".repeat(32), from: bot, to: bot }],
    swaps: [
      { tx: "0x" + "11".repeat(32), pool: oppA.buyPool, from: bot, tokenIn: oppA.tokenIn, amountIn: oppA.amountIn, amountOut: oppA.amountMid, applyToReserves: true },
      { tx: "0x" + "11".repeat(32), pool: oppA.sellPool, from: bot, tokenIn: oppA.tokenMid, amountIn: oppA.amountMid, amountOut: oppA.amountOut, applyToReserves: true },
    ],
  });
  await registry.refreshAll(n);
  ethUsd = registry.ethPrice();
  const detected = await classifier.classifyBlock(n, ethUsd);
  assert.equal(detected.filter((d) => d.type === "arbitrage").length, 1);
  opps = await scanner.scan(n, await gasEst.quote(n, null), ethUsd, 0.01);
  // Other pools are now out of line with the two the bot moved, so a new (smaller)
  // route appears; do not track it so the bookkeeping below stays simple.
  paper.onBlock(n, [], detected, ethUsd);

  let s = await summarize(store);
  assert.equal(s[0].taken, 1, "opportunity marked taken");
  assert.equal(s[0].takers[0].bot, bot);

  // After the bot's trade that exact route is exhausted (other pools may still be out of line).
  assert.ok(!opps.some((o) => o.buyPool === oppA.buyPool && o.sellPool === oppA.sellPool), "route closed by the bot");

  // Re-open a spread by moving Aerodrome's price (a big user buy), find it, then
  // let it persist one block (nobody takes it) -> "persisted".
  scenario.aeroWethUsdc.reserve0 = 50n * E18;
  scenario.aeroWethUsdc.reserve1 = 105_000n * E6;
  n = scenario.c.nextBlock();
  await registry.refreshAll(n);
  ethUsd = registry.ethPrice();
  opps = await scanner.scan(n, await gasEst.quote(n, null), ethUsd, 0.01);
  assert.equal(opps.length, 1);
  paper.onBlock(n, opps, [], ethUsd);
  n = scenario.c.nextBlock(); // N+1: still open
  await registry.refreshAll(n);
  paper.onBlock(n, [], [], ethUsd);
  n = scenario.c.nextBlock(); // N+2: finalize
  await registry.refreshAll(n);
  paper.onBlock(n, [], [], ethUsd);
  s = await summarize(store);
  assert.equal(s[0].persisted, 1, "opportunity persisted");
  assert.ok(s[0].realisticNetUsd > 0);

  // A third one that the market closes without a detectable arb tx -> "closed".
  scenario.aeroWethUsdc.reserve0 = 50n * E18;
  scenario.aeroWethUsdc.reserve1 = 105_000n * E6;
  n = scenario.c.nextBlock();
  await registry.refreshAll(n);
  opps = await scanner.scan(n, await gasEst.quote(n, null), ethUsd, 0.01);
  assert.equal(opps.length, 1);
  paper.onBlock(n, opps, [], ethUsd);
  scenario.aeroWethUsdc.reserve1 = 100_000n * E6; // price snaps back at N+1
  n = scenario.c.nextBlock();
  await registry.refreshAll(n);
  paper.onBlock(n, [], [], ethUsd);
  n = scenario.c.nextBlock();
  await registry.refreshAll(n);
  paper.onBlock(n, [], [], ethUsd);
  s = await summarize(store);
  assert.equal(s[0].closed, 1, "opportunity closed");
  assert.equal(s[0].found, 3);

  // Report renders with the numbers in it.
  const m = await marketSummary(store, (a) => registry.symbol(a));
  const html = renderReport(s[0].day, s[0], m[0], { mode: "paper", pools: registry.pools.size, pairs: 2, ethUsd });
  assert.ok(html.includes("Opportunities found"));
  assert.ok(html.includes("Bot leaderboard"));
  assert.ok(html.includes("<svg"));
});

test("discovery adapts to a provider's eth_getLogs range cap (Alchemy free tier: 10 blocks)", async (t) => {
  const sc = baseScenario();
  await sc.c.listen();
  // Close the mock server even if an assertion fails, or the open socket keeps the test run alive forever.
  t.after(() => sc.c.close().catch(() => undefined));
  sc.c.logsRangeLimit = 10;
  for (let i = 0; i < 25; i++) sc.c.nextBlock();
  sc.c.activityBlock();
  const c = new Chain(sc.c.url);
  t.after(() => c.destroy().catch(() => undefined));
  const r = new PoolRegistry(c);
  await r.discover({ minLiquidityWeth: 2, maxPools: 400, mode: "activity", lookbackBlocks: 30, logRange: 100 });
  assert.ok(r.pools.size >= 6, `found ${r.pools.size} pools despite the range cap`);
  const logsCalls = sc.c.requests.filter((m) => m === "eth_getLogs").length;
  assert.ok(logsCalls >= 4, `shrank to small windows (${logsCalls} getLogs calls)`);
  // Costs come from per-tx receipts now.
  const classifier = new Classifier(c, r, new Store(mkdtempSync(join(tmpdir(), "arbbot-cost-"))));
  const bot = "0xb0b0000000000000000000000000000000000009";
  const n = sc.c.nextBlock({
    txs: [{ hash: "0x" + "21".repeat(32), from: bot, to: bot }],
    swaps: [
      { tx: "0x" + "21".repeat(32), pool: sc.aeroWethUsdc.address, from: bot, tokenIn: sc.WETH, amountIn: E18, amountOut: 2090n * E6 },
      { tx: "0x" + "21".repeat(32), pool: sc.uniWethUsdc.address, from: bot, tokenIn: sc.USDC, amountIn: 2090n * E6, amountOut: (103n * E18) / 100n },
    ],
  });
  const det = await classifier.classifyBlock(n, 2000);
  assert.equal(det.length, 1);
  assert.ok(det[0].costUsd > 0, "gas cost attached from the receipt");
});

test("survives a rate-limited endpoint (JSON-RPC error and HTTP 429)", async (t) => {
  for (const mode of ["jsonrpc", "http"]) {
    const sc = baseScenario();
    await sc.c.listen();
    t.after(() => sc.c.close().catch(() => undefined));
    sc.c.rateLimitEvery = 3;
    sc.c.rateLimitMode = mode;
    // Public-endpoint pacing but no artificial delay, so the test stays fast.
    const c = new Chain(sc.c.url, undefined, { concurrency: 1, minIntervalMs: 0, batchMaxCount: 4, chunkSize: 120 });
    t.after(() => c.destroy().catch(() => undefined));
    const r = new PoolRegistry(c);
    assert.equal(await runCheck(c, V2_ONLY), true, `check under ${mode} rate limiting`);
    sc.c.activityBlock();
    await r.discover({ minLiquidityWeth: 2, maxPools: 400, mode: "activity", lookbackBlocks: 5, logRange: 2 });
    assert.ok(r.pools.size >= 6, `discovery under ${mode} rate limiting found ${r.pools.size} pools`);
    assert.ok(sc.c.rateLimited > 0, "the mock actually rate-limited us");
  }
});

test("main.js run loop works end to end against the mock (paper mode)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "arbbot-run-"));
  // Fresh scenario with an open spread; one block of activity so discovery sees the pools.
  const sc = baseScenario();
  await sc.c.listen();
  t.after(() => sc.c.close().catch(() => undefined));
  sc.c.activityBlock();
  // Every setting the bot would otherwise read from the developer's own .env is pinned here
  // (an empty value counts as set), so a real WS_URL, executor or key can never leak into the test.
  const env = {
    ...process.env,
    RPC_URL: sc.c.url,
    WS_URL: "",
    DATA_DIR: dir,
    REPORT_DIR: join(dir, "reports"),
    MODE: "paper",
    MIN_PROFIT_USD: "0.01",
    LOG_LEVEL: "info",
    DISCOVERY: "activity",
    DISCOVERY_LOOKBACK_BLOCKS: "20",
    DISCOVERY_LOG_RANGE: "10",
    EXECUTOR_ADDRESS: "",
    ROUTE_EXECUTOR_ADDRESS: "",
    PRIVATE_KEY: "",
    LIQUIDATIONS: "false",
    FLASHBLOCKS: "false",
    TOKEN_BLACKLIST: "",
    UI: "false",
    TELEGRAM_BOT_TOKEN: "",
  };
  const child = spawn(process.execPath, ["dist/main.js", "run"], { env, cwd: fileURLToPath(new URL("..", import.meta.url)) });
  const exited = new Promise((r) => child.once("exit", r));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  // Advance blocks while the bot polls; stop once an outcome has been finalized (or after 40s on a slow machine).
  const ticker = setInterval(() => sc.c.nextBlock(), 300);
  t.after(() => clearInterval(ticker));
  const deadline = Date.now() + 40_000;
  const oppsFile = join(dir, "opportunities.jsonl");
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (existsSync(oppsFile) && /"kind":"outcome"/.test(readFileSync(oppsFile, "utf8"))) break;
  }
  await new Promise((r) => setTimeout(r, 1500)); // let a report cycle run
  clearInterval(ticker);
  // The exit listener was attached at spawn, so this also resolves if the bot already stopped on its own.
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
  await exited;
  assert.ok(existsSync(join(dir, "pools.json")), "pools.json written\n" + out);
  assert.ok(existsSync(join(dir, "opportunities.jsonl")), "opportunities logged\n" + out);
  const lines = readFileSync(join(dir, "opportunities.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.kind === "opportunity"), "at least one opportunity");
  assert.ok(lines.some((l) => l.kind === "outcome" && l.status === "persisted"), "an outcome was finalized as persisted\n" + out);
  assert.ok(existsSync(join(dir, "reports", "latest.html")), "report written\n" + out);
  assert.ok(!/ERROR/.test(out), "no errors in output:\n" + out);
});
