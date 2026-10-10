/**
 * Per-block speed and repeated work: only routes through a changed pool are re-scored, each cycle is
 * scored once whichever token it is read from, V4 pools follow the PoolManager's events, depth is
 * real tokens (not virtual reserves) and prices come from deep pools only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder } from "ethers";
import { Scanner, preferredStart } from "../dist/scanner.js";
import { PoolRegistry, applyStateLog, poolKeyOfLog, activeRangeAmounts } from "../dist/pools.js";
import { findCycles, cycleKey } from "../dist/routes.js";
import { getSqrtRatioAtTick } from "../dist/clmath.js";
import { TOPIC_SWAP_V4, TOPIC_MODIFY_LIQUIDITY_V4 } from "../dist/abi.js";
import { BlockTimer } from "../dist/speed.js";
import { setLogLevel } from "../dist/log.js";

setLogLevel("error");
const abi = AbiCoder.defaultAbiCoder();
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TOK = "0x00000000000000000000000000000000000000aa";
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";

const v2 = (address, t0, t1, r0, r1) => ({ address, dex: "uniswap-v2", kind: "univ2", token0: t0, token1: t1, reserve0: r0, reserve1: r1, feePpm: 3000, feeModel: "ppm", stable: false, updatedBlock: 1 });
const gas = { totalWei: 1n, baseFeeWei: 1n, priorityFeeWei: 0n, l1FeeWei: 0n, block: 1, gasLimit: 1, l2FeeWei: 1n };
/** A chain whose quoters all fail: verification marks finds unverified; nothing here needs the network. */
const offline = { async multicall(calls) { return calls.map(() => ({ success: false, returnData: "0x" })); } };

function setup() {
  const r = new PoolRegistry(offline);
  // Two WETH/USDC pools 3% apart, and two TOK/WETH pools at the same price.
  r.pools.set("0x01", v2("0x01", WETH, USDC, 100n * E18, 300_000n * E6));
  r.pools.set("0x02", v2("0x02", WETH, USDC, 100n * E18, 309_000n * E6));
  r.pools.set("0x03", v2("0x03", TOK, WETH, 1_000_000n * E18, 100n * E18));
  r.pools.set("0x04", v2("0x04", TOK, WETH, 1_000_000n * E18, 100n * E18));
  const s = new Scanner(offline, r, undefined, false, { multiHop: true, maxHops: 3, maxCycles: 150, gasRouteBase: 1, gasHopV2: 1, gasHopCl: 1, flashSource: "morpho" });
  return { r, s };
}

test("a classic two-pool cycle is quoted once, starting in WETH, not once per token", () => {
  const { s } = setup();
  const quotes = s.findRaw();
  const wethUsdc = quotes.filter((q) => [q.buyPool.address, q.sellPool.address].sort().join() === "0x01,0x02");
  assert.equal(wethUsdc.length, 1, "one direction is profitable; its USDC-start rotation isn't quoted again");
  assert.equal(wethUsdc[0].tokenIn, WETH);
  assert.equal(preferredStart(USDC, WETH), WETH);
  assert.equal(preferredStart(TOK, USDC), USDC);
});

test("only routes through a pool that changed are re-scored; an unchanged open spread stays open", async () => {
  const { r, s } = setup();
  const first = await s.scan(10, gas, 3000, -Infinity, { stage: "block" });
  assert.ok(first.some((o) => o.buyPool === "0x01" || o.sellPool === "0x01"), "the WETH/USDC spread is found");
  const openKey = [...s.openRouteKeys()].find((k) => k.includes("0x01"));
  assert.ok(openKey, "and is open");
  assert.equal(s.lastTiming.full, true);

  // Nothing changed: nothing is re-scored, and the spread is still open.
  const before = s.funnel.candidates;
  const again = await s.scan(11, gas, 3000, -Infinity, { stage: "block" });
  assert.equal(again.length, 0);
  assert.equal(s.funnel.candidates, before, "no repeated route checks");
  assert.ok(s.funnel.unchanged > 0);
  assert.ok(s.openRouteKeys().has(openKey));

  // One TOK/WETH pool moves: only its pair is re-scored, the WETH/USDC spread is left alone.
  r.pools.get("0x03").reserve1 = 110n * E18;
  const third = await s.scan(12, gas, 3000, -Infinity, { stage: "block" });
  assert.ok(third.length > 0);
  assert.ok(third.every((o) => o.buyPool === "0x03" || o.sellPool === "0x03" || (o.route && o.route.pools.includes("0x03"))));
  assert.ok(s.openRouteKeys().has(openKey), "an untouched spread stays open");

  // The WETH/USDC prices converge: the route is re-scored and closes.
  r.pools.get("0x02").reserve1 = 300_000n * E6;
  await s.scan(13, gas, 3000, 0, { stage: "block" });
  assert.ok(!s.openRouteKeys().has(openKey), "closed once its pools changed and it no longer clears the floor");
});

test("a full re-check runs every FULL_RESCAN_BLOCKS whatever changed", async () => {
  const { s } = setup();
  s.fullRescanBlocks = 5;
  await s.scan(100, gas, 3000, -Infinity);
  await s.scan(101, gas, 3000, -Infinity);
  assert.equal(s.lastTiming.full, false);
  await s.scan(105, gas, 3000, -Infinity);
  assert.equal(s.lastTiming.full, true);
});

test("a cycle reached from both WETH and USDC is scored once", () => {
  const p = (address, t0, t1, r0, r1) => ({ ...v2(address, t0, t1, r0, r1), cl: undefined });
  // WETH -> USDC -> TOK -> WETH with an edge; read from USDC it is the same trade.
  const pools = [p("0xa", WETH, USDC, 100n * E18, 300_000n * E6), p("0xb", TOK, USDC, 1_000_000n * E18, 300_000n * E6), p("0xc", TOK, WETH, 1_000_000n * E18, 120n * E18)];
  const stats = { rotations: 0 };
  const cycles = findCycles(pools, { startTokens: [WETH, USDC], maxHops: 3, stats });
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].tokens[0], WETH);
  assert.equal(stats.rotations, 1);
  assert.equal(cycleKey(cycles[0].pools, cycles[0].tokens), cycleKey([pools[1], pools[2], pools[0]], [USDC, TOK, WETH, USDC]));
  assert.notEqual(cycleKey([pools[0], pools[1]], [WETH, USDC, WETH]), cycleKey([pools[1], pools[0]], [WETH, USDC, WETH]), "the two directions are different trades");
});

test("a Uniswap V4 Swap from the PoolManager updates the pool keyed by its poolId", () => {
  const id = "0x" + "12".repeat(32);
  const pool = {
    address: id, dex: "uniswap-v4", kind: "univ4", token0: WETH, token1: USDC, reserve0: 0n, reserve1: 0n, feePpm: 500, feeModel: "ppm", stable: false, updatedBlock: 0,
    cl: { sqrtPriceX96: 0n, tick: 0, liquidity: 0n, tickSpacing: 10, feePips: 500, words: new Map(), quoter: "0x" },
    v4: { poolId: id, currency0: "0x0000000000000000000000000000000000000000", currency1: USDC, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" },
  };
  const sqrt = getSqrtRatioAtTick(-200000);
  const swap = { address: POOL_MANAGER, topics: [TOPIC_SWAP_V4, id, "0x" + "00".repeat(32)], data: abi.encode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], [-5n, 7n, sqrt, 123n * E18, -200000, 500]), blockNumber: 9 };
  assert.equal(poolKeyOfLog(swap), id);
  assert.equal(applyStateLog(pool, swap), "set");
  assert.equal(pool.cl.sqrtPriceX96, sqrt);
  assert.equal(pool.cl.liquidity, 123n * E18);
  assert.equal(pool.cl.tick, -200000);
  assert.ok(pool.reserve0 > 0n && pool.reserve1 > 0n);
  const modify = { address: POOL_MANAGER, topics: [TOPIC_MODIFY_LIQUIDITY_V4, id, "0x" + "00".repeat(32)], data: "0x" };
  assert.equal(applyStateLog(pool, modify), "reread");
  // Some other contract's event with the same id topic isn't the PoolManager's.
  assert.equal(poolKeyOfLog({ ...swap, address: "0x00000000000000000000000000000000000000ff" }), "0x00000000000000000000000000000000000000ff");
});

test("depth is real tokens: a narrow concentrated range is not 100,000 WETH deep", () => {
  const r = new PoolRegistry(offline);
  // A WETH/wstETH-like pool: huge liquidity in a range a few ticks wide around 1:1.
  const words = new Map([[-1, 1n << 255n], [0, 1n << 1n]]); // initialized ticks at -1 and +1 (spacing 1)
  const cl = { sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, liquidity: 10n ** 26n, tickSpacing: 1, feePips: 100, words, quoter: "0x" };
  const pool = { address: "0xcl", dex: "uniswap-v4", kind: "univ4", token0: WETH, token1: TOK, reserve0: 10n ** 26n, reserve1: 10n ** 26n, feePpm: 100, feeModel: "ppm", stable: false, updatedBlock: 1, cl, v4: { poolId: "0xcl" } };
  const virtualWeth = Number(pool.reserve0) / 1e18;
  const depth = r.liquidityInWeth(pool, 3000);
  assert.ok(virtualWeth > 50_000_000, "virtual reserves are enormous");
  const range = activeRangeAmounts(cl);
  assert.ok(range && range.amount0 > 0n);
  assert.ok(depth < virtualWeth / 1000, `depth ${depth} WETH comes from the active range, not virtual reserves`);
  // With the pool's real balance known (V3-style pools), that is used.
  pool.v4 = undefined;
  pool.bal0 = 1234n * E18;
  assert.equal(r.liquidityInWeth(pool, 3000), 1234);
});

test("a token is priced through its deepest pool, and not at all through a thin one", () => {
  const r = new PoolRegistry(offline);
  r.priceMinDepthWeth = 1;
  r.tokens.set(TOK, { address: TOK, symbol: "TOK", decimals: 18 });
  // Thin pool says TOK = 1 WETH; deep pool says TOK = 0.001 WETH.
  r.pools.set("0x10", v2("0x10", TOK, WETH, E18 / 10n, E18 / 10n));
  r.pools.set("0x11", v2("0x11", TOK, WETH, 50_000n * E18, 50n * E18));
  const usd = r.usdValue(TOK, E18, 3000);
  assert.ok(Math.abs(usd - 3) < 1e-9, `priced via the deep pool: $${usd}`);
  const thin = new PoolRegistry(offline);
  thin.tokens.set(TOK, { address: TOK, symbol: "TOK", decimals: 18 });
  thin.pools.set("0x10", r.pools.get("0x10"));
  assert.equal(thin.usdValue(TOK, E18, 3000), null, "only a 0.1 WETH pool: no price rather than a wrong one");
});

test("the time-per-block summary reports the window, the slow blocks and the rates", () => {
  const t = new BlockTimer();
  const now = 1_000_000;
  const ph = { fetchMs: 100, refreshMs: 50, gasMs: 0, findMs: 300, verifyMs: 200, waitMs: 0, restMs: 10 };
  for (let i = 0; i < 30; i++) t.add(i, i < 3 ? 2500 : 660, ph, { scored: 10, unchanged: 90, candidates: 4, changedPools: 20, full: false }, now - (29 - i) * 2000);
  const s = t.summary(now);
  assert.equal(s.samples, 30);
  assert.equal(s.over2s, 3);
  assert.equal(s.p50Ms, 660);
  assert.equal(s.maxMs, 2500);
  assert.equal(s.phases.findMs, 300);
  // 30 blocks over 58 s, scaled to a minute.
  assert.equal(s.routeChecksPerMin, Math.round((120 * 60_000) / 58_000));
  assert.equal(s.unchangedPerMin, Math.round((2700 * 60_000) / 58_000));
});

test("Uniswap V4 pools survive a restart (saved in pools.json with their PoolKey)", () => {
  const r = new PoolRegistry(offline);
  const id = "0x" + "34".repeat(32);
  r.pools.set(id, {
    address: id, dex: "uniswap-v4", kind: "univ4", token0: WETH, token1: USDC, reserve0: 5n, reserve1: 6n, feePpm: 500, feeModel: "ppm", stable: false, updatedBlock: 3,
    cl: { sqrtPriceX96: 7n, tick: 1, liquidity: 8n, tickSpacing: 10, feePips: 500, words: new Map(), quoter: "0xq" },
    v4: { poolId: id, currency0: "0x0000000000000000000000000000000000000000", currency1: USDC, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" },
  });
  const back = new PoolRegistry(offline);
  back.loadSnapshot(JSON.parse(JSON.stringify(r.toSnapshot(3))));
  const p = back.pools.get(id);
  assert.ok(p, "still watched after a restart");
  assert.equal(p.v4.currency0, "0x0000000000000000000000000000000000000000");
  assert.equal(p.cl.sqrtPriceX96, 0n, "state is re-read on the first block, not trusted from disk");
});
