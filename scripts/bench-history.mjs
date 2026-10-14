// Per-block cost of the history hooks with 400 synthetic pools (no RPC, no ethers).
//
//   npm run build && node scripts/bench-history.mjs [pools=400] [blocks=200] [maxCycles=150] [probe|optimizer]
//
// Mirrors what Scanner.scan() does per block (findCycles + optimizeRoute per
// cycle, quoteArb per classic pool pair, the one-route-per-pool overlap filter)
// and measures what the history hooks add: a near-miss offer for every
// candidate below the minimum (NEAR_MISSES=true, band 1.5 so nearly all are in
// band: worst case) and attachSizeCurve for every opportunity that survives.
// The synthetic market is far more profitable than Base, so this is an upper bound.
import { findCycles, optimizeRoute } from "../dist/routes.js";
import { attachSizeCurve } from "../dist/sizecurve.js";
import { NearMissCollector } from "../dist/nearmiss.js";
import { quoteArb } from "../dist/math.js";
import { Store } from "../dist/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POOLS = Number(process.argv[2] ?? 400);
const BLOCKS = Number(process.argv[3] ?? 200);
const MAX_CYCLES = Number(process.argv[4] ?? 150); // MAX_CYCLES default
const MIN = 0.25; // MIN_PROFIT_USD default
const MODE = process.argv[5] ?? "probe";
const hookNs = { nearMiss: 0n, sizeCurve: 0n };
const E18 = 10n ** 18n;

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const tok = (i) => "0x" + i.toString(16).padStart(40, "0");
const WETH = tok(1);
const USDC = tok(2);
const TOKENS = Array.from({ length: 60 }, (_, i) => tok(i + 1));

function makePools() {
  const pools = [];
  for (let i = 0; i < POOLS; i++) {
    // Mostly WETH/USDC-anchored pairs so cycles exist, prices jittered so some are profitable.
    const a = rand() < 0.6 ? (rand() < 0.5 ? WETH : USDC) : TOKENS[Math.floor(rand() * TOKENS.length)];
    let b = TOKENS[Math.floor(rand() * 20)];
    if (b === a) b = a === WETH ? USDC : WETH;
    const [t0, t1] = a < b ? [a, b] : [b, a];
    const depth = BigInt(Math.floor(50 + rand() * 5000));
    const px = 1 + (rand() - 0.5) * 0.006;
    pools.push({ address: tok(10_000 + i), dex: ["uniswap-v2", "aerodrome", "baseswap"][i % 3], token0: t0, token1: t1, reserve0: depth * E18, reserve1: (depth * E18 * BigInt(Math.round(px * 1e6))) / 1_000_000n, feePpm: 3000, feeModel: "ppm" });
  }
  return pools;
}

function jiggle(pools) {
  for (const p of pools) if (rand() < 0.1) p.reserve1 = (p.reserve1 * BigInt(Math.round((1 + (rand() - 0.5) * 0.004) * 1e6))) / 1_000_000n;
}

function block(pools, hooks, nm, n, mode) {
  const byAddr = new Map(pools.map((p) => [p.address, p]));
  const cycles = findCycles(pools, { startTokens: [WETH, USDC], maxHops: 3, maxCycles: MAX_CYCLES });
  const opps = [];
  let candidates = 0;
  const consider = (o, gasUsd, key, dexes, hops) => {
    candidates++;
    const net = o.profitUsd - gasUsd;
    if (hooks && net < MIN) {
      const t = process.hrtime.bigint();
      nm.offer(n, net, MIN, () => ({ key, pairSymbols: "X", dexes, tokenInSymbol: "WETH", amountIn: o.amountIn, profitUsd: o.profitUsd, gasUsd, hops }));
      hookNs.nearMiss += process.hrtime.bigint() - t;
    }
    if (net >= MIN) opps.push({ ...o, netUsd: net });
  };
  for (const c of cycles) {
    const q = optimizeRoute(c);
    if (!q) continue;
    const o = { route: { pools: c.pools.map((p) => p.address), tokens: c.tokens }, buyPool: c.pools[0].address, sellPool: c.pools.at(-1).address, tokenIn: c.tokens[0], tokenMid: c.tokens[1], amountIn: q.amounts[0], profit: q.profit, profitUsd: (Number(q.profit) / 1e18) * 3000 };
    consider(o, 0.06, o.route.pools.join(">"), c.pools.map((p) => p.dex), c.pools.length);
  }
  const groups = new Map();
  for (const p of pools) groups.set(p.token0 + p.token1, [...(groups.get(p.token0 + p.token1) ?? []), p]);
  for (const g of groups.values())
    for (const buy of g)
      for (const sell of g) {
        if (buy === sell) continue;
        for (const tin of [buy.token0, buy.token1]) {
          const q = quoteArb(buy, sell, tin);
          if (!q) continue;
          const o = { buyPool: buy.address, sellPool: sell.address, tokenIn: q.tokenIn, tokenMid: q.tokenMid, amountIn: q.amountIn, profit: q.profit, profitUsd: (Number(q.profit) / 1e18) * 3000 };
          consider(o, 0.04, buy.address + sell.address + tin, [buy.dex, sell.dex], 2);
        }
      }
  // Overlap filter as in Scanner.scan: best first, one route per pool.
  opps.sort((a, b) => b.netUsd - a.netUsd);
  const used = new Set();
  const unique = opps.filter((o) => {
    const ps = o.route ? o.route.pools : [o.buyPool, o.sellPool];
    if (ps.some((p) => used.has(p))) return false;
    ps.forEach((p) => used.add(p));
    return true;
  });
  if (hooks) {
    const t = process.hrtime.bigint();
    for (const o of unique) attachSizeCurve(o, (a) => byAddr.get(a), mode);
    hookNs.sizeCurve += process.hrtime.bigint() - t;
  }
  return { kept: unique.length, candidates, cycles: cycles.length };
}

const dir = mkdtempSync(join(tmpdir(), "bench-history-"));
try {
  const store = new Store(dir);
  const results = {};
  // Interleave runs so JIT warm-up doesn't favour either side; keep the best of 3 each.
  for (let rep = 0; rep < 3; rep++)
    for (const hooks of [false, true]) {
      seed = 12345;
      hookNs.nearMiss = 0n;
      hookNs.sizeCurve = 0n;
      const pools = makePools();
      const nm = new NearMissCollector(store, { band: 1.5 });
      let stats = { kept: 0, candidates: 0, cycles: 0 };
      const t0 = process.hrtime.bigint();
      for (let n = 0; n < BLOCKS; n++) {
        jiggle(pools);
        const s = block(pools, hooks, nm, n, MODE);
        stats = { kept: stats.kept + s.kept, candidates: stats.candidates + s.candidates, cycles: stats.cycles + s.cycles };
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / BLOCKS;
      const k = hooks ? "with" : "without";
      if (!results[k] || ms < results[k].msPerBlock)
        results[k] = { msPerBlock: Number(ms.toFixed(3)), candidatesPerBlock: stats.candidates / BLOCKS, cyclesPerBlock: stats.cycles / BLOCKS, keptPerBlock: stats.kept / BLOCKS, nearMissesWritten: nm.stats.written,
          ...(hooks ? { hookMsPerBlock: { nearMiss: Number((Number(hookNs.nearMiss) / 1e6 / BLOCKS).toFixed(3)), sizeCurve: Number((Number(hookNs.sizeCurve) / 1e6 / BLOCKS).toFixed(3)) } } : {}) };
    }
  const extra = results.with.msPerBlock - results.without.msPerBlock;
  console.log(JSON.stringify({ pools: POOLS, blocks: BLOCKS, maxCycles: MAX_CYCLES, sizeCurveMode: MODE, ...results, extraMsPerBlock: Number(extra.toFixed(3)) }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
