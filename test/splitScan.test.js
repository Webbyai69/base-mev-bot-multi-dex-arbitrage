/**
 * Split trades as scanner opportunities (src/splitScan.ts): settings gates,
 * USD pricing and gas, the "beats the best single route" rule, per-leg quoter
 * verification and paper re-pricing. Uses a stub registry, so no RPC and no
 * ethers are needed. The pools are the mock chain's WETH/USDC scenario
 * (test/mockchain.mjs baseScenario): $2000 on Uniswap, Sushi and BaseSwap,
 * $2100 on Aerodrome.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSplitOpportunities, verifySplits, repriceSplit, splitGasUnits, splitKey, splitPools, SPLIT_DEFAULTS } from "../dist/splitScan.js";
import { hopOut } from "../dist/routes.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const ETH_USD = 2000;

function pool(address, dex, kind, t0, t1, r0, r1, feePpm = 3000, feeModel = "ppm") {
  return { address, dex, kind, token0: t0, token1: t1, reserve0: r0, reserve1: r1, feePpm, feeModel, stable: false, updatedBlock: 1000 };
}

/** The mock chain's WETH/USDC pools, as the registry holds them (token0 < token1: WETH 0x42.. < USDC 0x83..). */
function scenarioPools() {
  return [
    pool("0xaaaa000000000000000000000000000000000001", "uniswap-v2", "univ2", WETH, USDC, 100n * E18, 200_000n * E6),
    pool("0xaaaa000000000000000000000000000000000002", "sushiswap", "univ2", WETH, USDC, 100n * E18, 200_000n * E6),
    pool("0xaaaa000000000000000000000000000000000003", "aerodrome", "aerodrome", WETH, USDC, 50n * E18, 105_000n * E6, 3000, "bps"),
    pool("0xaaaa000000000000000000000000000000000004", "baseswap", "univ2", WETH, USDC, 30n * E18, 60_000n * E6, 2500),
  ];
}

function stubScanner(pools, extra = {}) {
  const map = new Map(pools.map((p) => [p.address, p]));
  return {
    registry: {
      pools: map,
      symbol: (a) => (a === WETH ? "WETH" : a === USDC ? "USDC" : a.slice(0, 8)),
      usdValue: (t, amt, ethUsd) => (t === WETH ? (Number(amt) / 1e18) * ethUsd : t === USDC ? Number(amt) / 1e6 : null),
      token: (a) => ({ decimals: a === USDC ? 6 : 18 }),
    },
    routeOpts: { gasRouteBase: 70_000, gasHopV2: 75_000, gasHopCl: 115_000 },
    ...extra,
  };
}

const ON = { ...SPLIT_DEFAULTS, enabled: true };
const input = (over = {}) => ({ block: 1000, gasPriceWei: 10_000_000n, l1FeeWei: 20_000_000_000_000n, ethUsd: ETH_USD, minNetUsd: 0.01, startTokens: [WETH, USDC], ...over });

test("off by default, and skipped on Flashblock scans unless SPLIT_ON_FLASHBLOCKS", () => {
  const s = stubScanner(scenarioPools());
  assert.equal(SPLIT_DEFAULTS.enabled, false);
  assert.deepEqual(findSplitOpportunities(s, SPLIT_DEFAULTS, input()), []);
  assert.deepEqual(findSplitOpportunities(s, ON, input({ stage: "flashblock" })), []);
  assert.equal(findSplitOpportunities(s, { ...ON, onFlashblocks: true }, input({ stage: "flashblock" })).length, 1);
});

test("mock-chain WETH/USDC: one split across all four pools, priced, gassed and better than the best single route", () => {
  const s = stubScanner(scenarioPools());
  const opps = findSplitOpportunities(s, ON, input());
  assert.equal(opps.length, 1, "the two directions share every pool, so only the better one is kept");
  const o = opps[0];
  assert.ok(o.split);
  assert.equal(o.route, undefined, "a split is not a RouteExecutor route");
  assert.equal(o.sim, "local");
  assert.equal(o.hops, 4);
  // Aerodrome is the dear-WETH venue: with WETH in, buy USDC there and sell it on the three $2000 pools (1>3);
  // with USDC in, the mirror (3>1). Either way all four pools are used.
  assert.deepEqual(splitPools(o.split).sort(), scenarioPools().map((p) => p.address).sort());
  assert.match(o.pairSymbols, /^(WETH\/USDC split 1>3|USDC\/WETH split 3>1)$/);
  assert.equal(o.split.gasUnits, splitGasUnits([{}, {}, {}, {}], s.routeOpts));
  assert.equal(o.split.gasUnits, 70_000 + 4 * 75_000);
  assert.ok(o.netUsd > 0 && Math.abs(o.netUsd - (o.profitUsd - o.gasUsd)) < 1e-9);
  assert.ok(o.split.bestSingle && o.split.bestSingle.netUsd !== null);
  assert.ok(o.netUsd > o.split.bestSingle.netUsd, "split net must beat the single route's net");
  assert.ok(Math.abs(o.split.gainUsd - (o.netUsd - o.split.bestSingle.netUsd)) < 1e-9);
  // Exact legs.
  const tin = o.tokenIn;
  const tmid = o.tokenMid;
  let paid = 0n, bought = 0n, got = 0n;
  for (const l of o.split.buys) {
    assert.equal(hopOut(s.registry.pools.get(l.pool), tin, l.amountIn), l.amountOut);
    paid += l.amountIn;
    bought += l.amountOut;
  }
  for (const l of o.split.sells) {
    assert.equal(hopOut(s.registry.pools.get(l.pool), tmid, l.amountIn), l.amountOut);
    got += l.amountOut;
  }
  assert.equal(o.amountIn, paid);
  assert.equal(o.amountMid, bought);
  assert.equal(o.amountOut, got);
  assert.equal(o.profit, got - paid);
  assert.equal(o.split.dust, 0n);
  assert.match(splitKey(o), /^split:/);
});

test("minNetUsd and blocked tokens filter splits", () => {
  const s = stubScanner(scenarioPools());
  const [o] = findSplitOpportunities(s, ON, input());
  assert.deepEqual(findSplitOpportunities(s, ON, input({ minNetUsd: o.netUsd + 1 })), []);
  const blocked = stubScanner(scenarioPools(), { blockedTokens: () => new Set([USDC]) });
  assert.deepEqual(findSplitOpportunities(blocked, ON, input()), []);
});

test("gas: legs that don't pay for themselves are pruned, and at high gas no split beats the single route", () => {
  const s = stubScanner(scenarioPools());
  const at = (gwei) => findSplitOpportunities(s, ON, input({ gasPriceWei: BigInt(gwei * 1e9), l1FeeWei: 0n, minNetUsd: -1e9 }));
  const cheap = at(0.01);
  assert.equal(cheap.length, 1);
  assert.equal(cheap[0].hops, 4, "at 0.01 gwei every pool is worth a leg");
  const dear = at(10);
  assert.equal(dear.length, 1);
  assert.equal(dear[0].hops, 3, "at 10 gwei the smallest leg (BaseSwap) is pruned");
  assert.ok(!splitPools(dear[0].split).includes(scenarioPools()[3].address));
  assert.ok(dear[0].netUsd > dear[0].split.bestSingle.netUsd);
  assert.deepEqual(at(100), [], "at 100 gwei the single route wins");
});

test("only: a Flashblock hot-pool subset with fewer than three pools of the pair yields nothing", () => {
  const ps = scenarioPools();
  const s = stubScanner(ps);
  assert.deepEqual(findSplitOpportunities(s, { ...ON, onFlashblocks: true }, input({ stage: "flashblock", only: new Set([ps[0].address, ps[2].address]) })), []);
});

/** Fake per-hop quoter: answers with the exact pool maths, optionally perturbed. */
function deps(pools, perturb = () => 0n, fail = () => false) {
  const map = new Map(pools.map((p) => [p.address, p]));
  return {
    pool: (a) => map.get(a),
    quoteCall: (p, tin, tout, amt) => ({ target: p.address, callData: JSON.stringify({ tin, amt: amt.toString() }) }),
    decode: (p, r) => (r.success ? BigInt(r.returnData) : null),
    multicall: async (calls) =>
      calls.map((c) => {
        const { tin, amt } = JSON.parse(c.callData);
        const p = map.get(c.target);
        if (fail(p)) return { success: false, returnData: "0x" };
        return { success: true, returnData: String(hopOut(p, tin, BigInt(amt)) + perturb(p)) };
      }),
  };
}

test("verifySplits: quoter-ok when every leg matches, quoter-mismatch (with the leg) otherwise; never executor-*", async () => {
  const ps = scenarioPools();
  const s = stubScanner(ps);
  const fresh = () => findSplitOpportunities(s, ON, input());

  const ok = fresh();
  await verifySplits(ok, 1000, deps(ps));
  assert.equal(ok[0].sim, "quoter-ok");

  const off = fresh();
  await verifySplits(off, 1000, deps(ps, (p) => (p.dex === "baseswap" ? 1n : 0n)));
  assert.equal(off[0].sim, "quoter-mismatch");
  assert.match(off[0].simDetail, /baseswap/);

  const failed = fresh();
  await verifySplits(failed, 1000, deps(ps, () => 0n, (p) => p.dex === "aerodrome"));
  assert.equal(failed[0].sim, "quoter-mismatch");
  assert.match(failed[0].simDetail, /quoter call failed/);

  const down = fresh();
  const d = deps(ps);
  let warned = "";
  await verifySplits(down, 1000, { ...d, multicall: async () => { throw new Error("rpc down"); }, warn: (m) => (warned = m) });
  assert.equal(down[0].sim, "local", "an RPC failure leaves the split unverified");
  assert.match(warned, /rpc down/);

  for (const o of [...ok, ...off, ...failed, ...down]) assert.ok(!o.sim.startsWith("executor"), "splits are never executor-verified");
});

test("repriceSplit: same state gives the same profit; a rival trade on a leg pool shrinks or kills it", () => {
  const ps = scenarioPools();
  const s = stubScanner(ps);
  const [o] = findSplitOpportunities(s, ON, input());
  const byAddr = new Map(ps.map((p) => [p.address, p]));
  assert.equal(repriceSplit(o, (a) => byAddr.get(a)), o.profit);
  // Someone arbs Aerodrome back to $2000: the split's edge is gone.
  const aero = ps[2];
  const fixed = new Map(byAddr);
  fixed.set(aero.address, { ...aero, reserve0: 51n * E18 + E18 / 4n, reserve1: 102_500n * E6 });
  const after = repriceSplit(o, (a) => fixed.get(a));
  assert.ok(after === null || after < o.profit / 4n, `re-priced ${after} vs ${o.profit}`);
  // A pool dropped from the watch list: cannot re-price.
  assert.equal(repriceSplit(o, (a) => (a === aero.address ? undefined : byAddr.get(a))), null);
});
