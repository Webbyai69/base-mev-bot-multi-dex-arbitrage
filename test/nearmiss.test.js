/**
 * Near-miss log (src/nearmiss.ts) and size curves (src/sizecurve.ts +
 * optimizeRoute's onSample in src/routes.ts). No RPC, no ethers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/store.js";
import { NearMissCollector, nearMissesFromEnv, NEAR_MISS_CODES } from "../dist/nearmiss.js";
import { FUNNEL_STAGES } from "../dist/digest.js";
import { SizeCurveRecorder, spreadSamples, classicSizeCurve, sizeCurvesEnabled, toCurve } from "../dist/sizecurve.js";
import { optimizeRoute, evaluateRoute } from "../dist/routes.js";
import { quoteArb } from "../dist/math.js";

const info = (key, extra = {}) => () => ({ key, pairSymbols: "WETH/USDC", dexes: ["uniswap-v2", "aerodrome"], tokenInSymbol: "WETH", amountIn: 10n ** 18n, profitUsd: 0.3, gasUsd: 0.1, hops: 2, ...extra });

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nearmiss-"));
  try {
    return await fn(new Store(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("near-miss codes are the digest's funnel codes", async () => {
  const codes = FUNNEL_STAGES.map((s) => s.code);
  assert.ok(codes.includes(NEAR_MISS_CODES.gas));
  assert.ok(codes.includes(NEAR_MISS_CODES.low));
  assert.equal(NEAR_MISS_CODES.gas, "NET_NEGATIVE_AFTER_GAS");
  assert.equal(NEAR_MISS_CODES.low, "NET_PROFIT_TOO_LOW");
});

test("off unless NEAR_MISSES=true; NEAR_MISS_BAND overrides the band", async () => {
  await withStore((store) => {
    assert.equal(nearMissesFromEnv(store, {}), undefined);
    assert.equal(nearMissesFromEnv(store, { NEAR_MISSES: "false" }), undefined);
    assert.equal(nearMissesFromEnv(store, { NEAR_MISSES: "true" }).band, 0.5);
    assert.equal(nearMissesFromEnv(store, { NEAR_MISSES: "TRUE", NEAR_MISS_BAND: "1.5" }).band, 1.5);
    assert.equal(nearMissesFromEnv(store, { NEAR_MISSES: "true", NEAR_MISS_BAND: "junk" }).band, 0.5);
  });
});

test("keeps the best 5 in band per block, writes them when the block changes", async () => {
  await withStore(async (store) => {
    const nm = new NearMissCollector(store);
    const min = 1.0; // band 0.5 -> net in [0.5, 1.0)
    let calls = 0;
    const counted = (k) => () => (calls++, info(k)());
    for (const [k, net] of [["a", 0.9], ["b", 0.4], ["c", 0.55], ["d", 0.99], ["e", 0.7], ["f", 0.6], ["g", 0.8], ["h", 1.2], ["i", -0.3], ["j", 0.51]]) nm.offer(100, net, min, counted(k));
    // in band: a .9, c .55, d .99, e .7, f .6, g .8, j .51 -> best 5: d a g e f
    assert.deepEqual(nm.pending().map((r) => r.netUsd), [0.99, 0.9, 0.8, 0.7, 0.6]);
    assert.ok(calls <= 7, `info() only for in-band candidates that make the buffer (called ${calls}x)`);
    nm.offer(101, 0.75, min, info("z"));
    const recs = await store.readAll("near-misses.jsonl");
    assert.equal(recs.length, 5);
    assert.deepEqual(recs.map((r) => r.block), [100, 100, 100, 100, 100]);
    const r = recs[0];
    assert.equal(r.code, "NET_PROFIT_TOO_LOW");
    assert.equal(r.pairSymbols, "WETH/USDC");
    assert.deepEqual(r.dexes, ["uniswap-v2", "aerodrome"]);
    assert.equal(r.amountIn, "1000000000000000000");
    assert.equal(r.profitUsd, 0.3);
    assert.equal(r.gasUsd, 0.1);
    assert.equal(r.netUsd, 0.99);
    assert.ok(Math.abs(r.shortUsd - 0.01) < 1e-9);
    assert.ok(typeof r.at === "string" && r.at.endsWith("Z"));
    assert.deepEqual(nm.pending().map((x) => x.netUsd), [0.75]);
  });
});

test("same route seen again in the block (flashblocks) keeps only its best", async () => {
  await withStore((store) => {
    const nm = new NearMissCollector(store);
    nm.offer(5, 0.6, 1, info("r1"));
    nm.offer(5, 0.7, 1, info("r2"));
    nm.offer(5, 0.8, 1, info("r1", { stage: "flashblock" }));
    nm.offer(5, 0.65, 1, info("r1"));
    assert.deepEqual(nm.pending().map((r) => [r.netUsd, r.stage]), [[0.8, "flashblock"], [0.7, "block"]]);
  });
});

test("gas-negative candidates qualify only when the band reaches below zero", async () => {
  await withStore((store) => {
    const narrow = new NearMissCollector(store);
    narrow.offer(1, -0.1, 1, info("x"));
    assert.equal(narrow.pending().length, 0);
    const wide = new NearMissCollector(store, { band: 1.5 }); // net >= -0.5
    wide.offer(1, -0.1, 1, info("x"));
    wide.offer(1, -0.6, 1, info("y"));
    assert.deepEqual(wide.pending().map((r) => [r.code, r.netUsd]), [["NET_NEGATIVE_AFTER_GAS", -0.1]]);
    // no minimum (check command runs with -Infinity) -> nothing is a near miss
    wide.offer(1, -0.1, -Infinity, info("z"));
    wide.offer(1, -0.1, 0, info("z"));
    assert.equal(wide.pending().length, 1);
  });
});

test("near-miss offer stays cheap: 1M out-of-band + 100k in-band offers", async () => {
  await withStore((store) => {
    const nm = new NearMissCollector(store);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1_000_000; i++) nm.offer(Math.floor(i / 2000), -1, 1, info("k"));
    for (let i = 0; i < 100_000; i++) nm.offer(1000 + Math.floor(i / 2000), 0.5 + (i % 997) / 2000, 1, info(String(i % 50)));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // ~2000 candidates per block -> per-block cost is ms / blocks
    const blocks = 1_000_000 / 2000 + 100_000 / 2000;
    assert.ok(ms / blocks < 0.5, `${(ms / blocks).toFixed(3)} ms per block`);
  });
});

// ---------------------------------------------------------------------------
// Size curves
// ---------------------------------------------------------------------------

const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";
const C = "0x000000000000000000000000000000000000000c";
const E18 = 10n ** 18n;
const v2 = (address, t0, t1, r0, r1, feePpm = 3000) => ({ address, dex: "test-v2", token0: t0, token1: t1, reserve0: r0, reserve1: r1, feePpm, feeModel: "ppm" });
const tri = { pools: [v2("0xab", A, B, 1000n * E18, 2000n * E18), v2("0xbc", B, C, 1000n * E18, 3000n * E18), v2("0xca", A, C, 900n * E18, 5000n * E18)], tokens: [A, B, C, A] };

test("SIZE_CURVES is on by default", async () => {
  assert.equal(sizeCurvesEnabled({}), true);
  assert.equal(sizeCurvesEnabled({ SIZE_CURVES: "false" }), false);
});

test("optimizeRoute onSample sees every feasible evaluation and changes nothing", async () => {
  const seen = [];
  const plain = optimizeRoute(tri);
  const sampled = optimizeRoute(tri, undefined, (x, p) => seen.push([x, p]));
  assert.deepEqual(sampled.amounts, plain.amounts);
  assert.equal(sampled.profit, plain.profit);
  assert.ok(seen.length > 50, `${seen.length} samples`);
  for (const [x, p] of seen.slice(0, 40)) assert.equal(evaluateRoute(tri, x).profit, p);
  assert.ok(seen.some(([x]) => x === plain.amounts[0]), "the chosen size is among the samples");
});

test("recorder reduces to <= 12 evenly spread points including the optimum", async () => {
  const rec = new SizeCurveRecorder();
  rec.begin();
  const q = optimizeRoute(tri, undefined, rec.sample);
  rec.keep(q);
  const curve = rec.curve(q, q.profit, 10);
  assert.ok(curve.length >= 6 && curve.length <= 12, `${curve.length} points`);
  const xs = curve.map(([x]) => BigInt(x));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], "sorted by size, no duplicates");
  // The best point earns exactly the optimiser's profit (wei-level ties near the top can sit at a neighbouring size).
  const best = curve.reduce((a, b) => (b[1] > a[1] ? b : a));
  assert.equal(evaluateRoute(tri, BigInt(best[0])).profit, q.profit);
  assert.ok(Math.abs(best[1] - 10) < 1e-6, "USD scaled from the opportunity's own profit");
  assert.ok(curve.every(([, usd]) => usd <= 10 + 1e-9));
  assert.equal(new SizeCurveRecorder().curve({}, 1n, 1), undefined);
});

test("spreadSamples picks evenly over the range", async () => {
  const xs = Array.from({ length: 1000 }, (_, i) => BigInt(i + 1));
  const ps = xs.map((x) => -((x - 700n) ** 2n));
  const s = spreadSamples(xs, ps, 12);
  assert.equal(s.length, 12);
  assert.equal(s[0][0], 1n);
  assert.equal(s[s.length - 1][0], 1000n);
  assert.ok(s.some(([x]) => x === 700n), "best kept");
  assert.deepEqual(spreadSamples([5n, 5n, 3n], [1n, 1n, 2n]), [[3n, 2n], [5n, 1n]]);
  assert.equal(toCurve([[1n, 1n]], 0n, 1), undefined);
});

test("classic curve peaks at the closed-form size", async () => {
  const buy = v2("0x01", A, B, 1000n * E18, 2000n * E18);
  const sell = v2("0x02", A, B, 1000n * E18, 2100n * E18);
  const q = quoteArb(buy, sell, B, undefined) ?? quoteArb(buy, sell, A, undefined);
  assert.ok(q);
  const curve = classicSizeCurve(buy, sell, q.tokenIn, q.tokenMid, q.amountIn, q.profit, 5);
  assert.equal(curve.length, 12);
  const best = curve.reduce((a, b) => (b[1] > a[1] ? b : a));
  assert.equal(best[0], q.amountIn.toString(), "6/6 of the chosen size is the best point");
  assert.ok(Math.abs(best[1] - 5) < 1e-6);
  assert.ok(curve[11][1] < curve[5][1], "2x the size earns less");
});

test("attachSizeCurve: probe for multi-hop and classic, optimizer mode, never throws", async () => {
  const { attachSizeCurve, sizeCurveMode } = await import("../dist/sizecurve.js");
  assert.equal(sizeCurveMode({}), "probe");
  assert.equal(sizeCurveMode({ SIZE_CURVES: "true" }), "probe");
  assert.equal(sizeCurveMode({ SIZE_CURVES: "optimizer" }), "optimizer");
  assert.equal(sizeCurveMode({ SIZE_CURVES: "false" }), false);
  const byAddr = new Map(tri.pools.map((p) => [p.address, p]));
  const get = (a) => byAddr.get(a);
  const q = optimizeRoute(tri);
  const opp = () => ({ route: { pools: tri.pools.map((p) => p.address), tokens: tri.tokens }, buyPool: "0xab", sellPool: "0xca", tokenIn: A, tokenMid: B, amountIn: q.amounts[0], profit: q.profit, profitUsd: 7 });

  const probe = opp();
  attachSizeCurve(probe, get, "probe");
  assert.equal(probe.sizeCurve.length, 12);
  assert.equal(probe.sizeCurve[5][0], q.amounts[0].toString());
  assert.ok(Math.abs(probe.sizeCurve[5][1] - 7) < 1e-6);
  assert.ok(probe.sizeCurve.every(([, usd]) => usd <= 7 + 1e-9), "the chosen size is the peak");

  const opt = opp();
  attachSizeCurve(opt, get, "optimizer");
  assert.ok(opt.sizeCurve.length >= 6 && opt.sizeCurve.length <= 12);
  assert.ok(Math.abs(Math.max(...opt.sizeCurve.map(([, u]) => u)) - 7) < 1e-6);

  const off = opp();
  attachSizeCurve(off, get, false);
  assert.equal(off.sizeCurve, undefined);
  const missing = opp();
  attachSizeCurve(missing, () => undefined, "probe");
  assert.equal(missing.sizeCurve, undefined);
  const broken = opp();
  attachSizeCurve(broken, () => { throw new Error("boom"); }, "probe");
  assert.equal(broken.sizeCurve, undefined);

  const buy = v2("0x01", A, B, 1000n * E18, 2000n * E18);
  const sell = v2("0x02", A, B, 1000n * E18, 2100n * E18);
  const cq = quoteArb(buy, sell, A) ?? quoteArb(buy, sell, B);
  const classic = { buyPool: "0x01", sellPool: "0x02", tokenIn: cq.tokenIn, tokenMid: cq.tokenMid, amountIn: cq.amountIn, profit: cq.profit, profitUsd: 3 };
  attachSizeCurve(classic, (a) => (a === "0x01" ? buy : sell), "probe");
  assert.equal(classic.sizeCurve.length, 12);
});
