/**
 * Split trades: the common-marginal-price optimiser against brute-force grid
 * search, exactness of every reported leg, CL range caps, and the "no trade"
 * cases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSplitTrades, quoteSplit, evaluatePlan, bestSingleRoute, splitLabel } from "../dist/split.js";
import { hopOut, optimizeRoute } from "../dist/routes.js";
import { getSqrtRatioAtTick, clMaxInput } from "../dist/clmath.js";

const A = "0x000000000000000000000000000000000000000a"; // X (start token, "WETH")
const B = "0x000000000000000000000000000000000000000b"; // Y
const C = "0x000000000000000000000000000000000000000c";
const E18 = 10n ** 18n;

function cp(address, rA, rB, feePpm = 3000, feeModel = "ppm") {
  return { address, dex: "test-v2", kind: "univ2", token0: A, token1: B, reserve0: rA, reserve1: rB, feePpm, feeModel };
}

/**
 * CL pool A/B (token0 = A) at `price` B per A with liquidity L, and initialized
 * ticks `below` / `above` tick-spacings away from the current tick.
 */
function clp(address, price, L, feePips = 500, below = 40, above = 40, spacing = 10) {
  const tick = Math.round(Math.log(price) / Math.log(1.0001));
  const cl = { sqrtPriceX96: getSqrtRatioAtTick(tick), tick, liquidity: L, tickSpacing: spacing, feePips, words: new Map() };
  const c = Math.floor(tick / spacing);
  const set = (ct) => {
    const w = ct >> 8;
    const bit = ((ct % 256) + 256) % 256;
    cl.words.set(w, (cl.words.get(w) ?? 0n) | (1n << BigInt(bit)));
  };
  for (let w = (c >> 8) - 2; w <= (c >> 8) + 2; w++) cl.words.set(w, 0n);
  set(c - below);
  set(c + above);
  const Q96 = 1n << 96n;
  return {
    address, dex: "test-cl", kind: "univ3", token0: A, token1: B,
    reserve0: (L * Q96) / cl.sqrtPriceX96, reserve1: (L * cl.sqrtPriceX96) / Q96,
    feePpm: feePips, feeModel: "ppm", cl,
  };
}

/** Exact profit of buying with `xs[i]` on buys[i], then selling the Y by `fr` (fractions, last takes rest). */
function bruteEval(buys, sells, xs, fr) {
  let y = 0n;
  let paid = 0n;
  for (let i = 0; i < buys.length; i++) {
    if (xs[i] <= 0n) continue;
    // CL buys are clamped at their in-range capacity, so the grid explores the whole feasible region.
    if (buys[i].cl && xs[i] > clMaxInput(buys[i].cl, true)) xs[i] = clMaxInput(buys[i].cl, true);
    const o = hopOut(buys[i], A, xs[i]);
    if (o === null) return null;
    y += o;
    paid += xs[i];
  }
  if (y === 0n) return null;
  let got = 0n;
  let left = y;
  for (let j = 0; j < sells.length; j++) {
    const amt = j === sells.length - 1 ? left : (y * BigInt(Math.round(fr[j] * 1e9))) / 1_000_000_000n;
    if (amt > left) return null;
    if (amt === 0n) continue;
    const o = hopOut(sells[j], B, amt);
    if (o === null) return null;
    if (sells[j].cl && amt > clMaxInput(sells[j].cl, false)) return null;
    got += o;
    left -= amt;
  }
  return got - paid;
}

/**
 * Multi-resolution grid search over the buy inputs and the sell fractions:
 * a grid of `n` points per dimension, then zoom around the best point. The
 * search is independent of the optimiser (no marginal-price maths).
 */
function bruteForce(buys, sells, maxX, n = 9, levels = 22) {
  const dims = buys.length + sells.length - 1;
  let lo = [...buys.map(() => 0), ...sells.slice(1).map(() => 0)];
  let hi = [...buys.map(() => maxX), ...sells.slice(1).map(() => 1)];
  let best = -Infinity;
  let bestPt = null;
  for (let lv = 0; lv < levels; lv++) {
    const idx = new Array(dims).fill(0);
    for (;;) {
      const pt = idx.map((k, d) => lo[d] + ((hi[d] - lo[d]) * k) / (n - 1));
      const fr = pt.slice(buys.length);
      if (fr.reduce((s, v) => s + v, 0) <= 1) {
        const xs = pt.slice(0, buys.length).map((v) => BigInt(Math.floor(v)));
        const p = bruteEval(buys, sells, xs, fr);
        if (p !== null && Number(p) > best) {
          best = Number(p);
          bestPt = pt;
        }
      }
      let d = 0;
      while (d < dims && ++idx[d] === n) idx[d++] = 0;
      if (d === dims) break;
    }
    if (!bestPt) break;
    lo = bestPt.map((v, d) => Math.max(d < buys.length ? 0 : 0, v - (hi[d] - lo[d]) / (n - 1)));
    hi = bestPt.map((v, d) => Math.min(d < buys.length ? maxX : 1, v + (hi[d] - lo[d]) / (n - 1)));
  }
  return best;
}

/** Every leg of a quote re-run through the exact per-pool function gives the reported numbers. */
function assertExact(q) {
  let paid = 0n;
  let y = 0n;
  for (const l of q.buys) {
    assert.equal(hopOut(l.pool, q.tokenIn, l.amountIn), l.amountOut, "buy leg is not the exact pool output");
    paid += l.amountIn;
    y += l.amountOut;
  }
  let got = 0n;
  let sold = 0n;
  for (const l of q.sells) {
    assert.equal(hopOut(l.pool, q.tokenMid, l.amountIn), l.amountOut, "sell leg is not the exact pool output");
    got += l.amountOut;
    sold += l.amountIn;
  }
  assert.equal(q.amountIn, paid);
  assert.equal(q.amountMid, y);
  assert.equal(q.amountOut, got);
  assert.equal(q.dust, y - sold);
  assert.ok(sold <= y, "cannot sell more Y than was bought");
  assert.equal(q.profit, got - paid, "reported profit must equal the exact re-evaluation");
}

function assertCaps(q) {
  for (const l of q.buys) if (l.pool.cl) assert.ok(l.amountIn <= clMaxInput(l.pool.cl, l.pool.token0 === q.tokenIn), "CL buy leg crosses its range");
  for (const l of q.sells) if (l.pool.cl) assert.ok(l.amountIn <= clMaxInput(l.pool.cl, l.pool.token0 !== q.tokenIn), "CL sell leg crosses its range");
}

function within(opt, brute, tol = 0.001) {
  if (process.env.SPLIT_DEBUG) console.log("opt/brute", Number(opt) / brute);
  assert.ok(brute > 0, "brute force found no profit");
  assert.ok(Number(opt) >= brute * (1 - tol), `optimiser ${opt} is more than ${tol * 100}% below brute force ${brute}`);
}

const legPools = (legs) => legs.map((l) => l.pool.address).sort();

test("three pools (CP): two cheap pools feed one dear pool, within 0.1% of brute force", () => {
  const p1 = cp("0x01", 1000n * E18, 2_100_000n * E18);
  const p2 = cp("0x02", 600n * E18, 1_255_000n * E18, 2500);
  const p3 = cp("0x03", 1500n * E18, 3_000_000n * E18);
  const q = quoteSplit([p1, p2, p3], A, B);
  assert.ok(q, "expected a split");
  assert.deepEqual(legPools(q.buys), ["0x01", "0x02"]);
  assert.deepEqual(legPools(q.sells), ["0x03"]);
  assertExact(q);
  assert.equal(q.dust, 0n);
  const brute = bruteForce([p1, p2], [p3], 60e18);
  within(q.profit, brute);
  assert.ok(q.bestSingle && q.profit > q.bestSingle.profit, "split must beat the best single route");
  assert.equal(q.gain, q.profit - q.bestSingle.profit);
});

test("four pools (CP + CL mixed): 2 buys > 2 sells, within 0.1% of brute force", () => {
  const p1 = cp("0x01", 1000n * E18, 2_100_000n * E18);
  const p2 = clp("0x02", 2095, 2n * 10n ** 22n, 500, 200, 200);
  const p3 = cp("0x03", 1500n * E18, 3_000_000n * E18, 3000, "bps");
  const p4 = clp("0x04", 2005, 3n * 10n ** 22n, 500, 200, 200);
  const q = quoteSplit([p1, p2, p3, p4], A, B);
  assert.ok(q, "expected a split");
  assert.deepEqual(legPools(q.buys), ["0x01", "0x02"]);
  assert.deepEqual(legPools(q.sells), ["0x03", "0x04"]);
  assertExact(q);
  assertCaps(q);
  const brute = bruteForce([p1, p2], [p3, p4], 60e18);
  within(q.profit, brute);
});

test("five pools (CP + CL mixed): 3 buys > 2 sells, within 0.1% of brute force", () => {
  const p1 = cp("0x01", 800n * E18, 1_690_000n * E18);
  const p2 = clp("0x02", 2110, 1n * 10n ** 22n, 500, 300, 300);
  const p3 = cp("0x03", 400n * E18, 842_000n * E18, 1000);
  const p4 = clp("0x04", 2000, 2n * 10n ** 22n, 500, 300, 300);
  const p5 = cp("0x05", 1200n * E18, 2_400_000n * E18, 3000, "bps");
  const q = quoteSplit([p1, p2, p3, p4, p5], A, B);
  assert.ok(q, "expected a split");
  assert.deepEqual(legPools(q.buys), ["0x01", "0x02", "0x03"]);
  assert.deepEqual(legPools(q.sells), ["0x04", "0x05"]);
  assertExact(q);
  assertCaps(q);
  const brute = bruteForce([p1, p2, p3], [p4, p5], 40e18, 7, 26);
  within(q.profit, brute);
});

test("CL range caps bind and are respected; a bigger leg would be infeasible", () => {
  // Very cheap CL pool with a narrow range: the buy leg is capped at its next initialized tick.
  const p1 = clp("0x01", 2150, 5n * 10n ** 22n, 500, 2, 2);
  const p2 = cp("0x02", 1000n * E18, 2_080_000n * E18);
  const p3 = cp("0x03", 1500n * E18, 3_000_000n * E18);
  const cap = clMaxInput(p1.cl, true);
  const q = quoteSplit([p1, p2, p3], A, B);
  assert.ok(q, "expected a split");
  assertExact(q);
  assertCaps(q);
  const leg = q.buys.find((l) => l.pool === p1);
  assert.ok(leg, "the cheap CL pool must be used");
  // the continuous optimum wants more than the range holds, so the cap binds (to within rounding)
  assert.ok(leg.amountIn <= cap && leg.amountIn * 1000n >= cap * 999n, `CL leg ${leg.amountIn} should sit at its cap ${cap}`);
  assert.equal(hopOut(p1, A, cap * 2n), null, "beyond the cap the CL maths refuses (range crossed)");
  within(q.profit, bruteForce([p1, p2], [p3], 60e18));
});

test("two equal pools produce no trade; three equal pools produce no trade", () => {
  const a = cp("0x01", 1000n * E18, 2_000_000n * E18);
  const b = cp("0x02", 1000n * E18, 2_000_000n * E18);
  const c = cp("0x03", 1000n * E18, 2_000_000n * E18);
  assert.equal(quoteSplit([a, b], A, B), null);
  assert.equal(quoteSplit([a, b, c], A, B), null);
  assert.deepEqual(findSplitTrades([a, b, c], [A]), []);
  assert.equal(bestSingleRoute([a, b, c], A, B), null);
});

test("spread inside the fee band produces no trade", () => {
  const a = cp("0x01", 1000n * E18, 2_004_000n * E18); // 0.2% apart, fees 0.3% each side
  const b = cp("0x02", 1000n * E18, 2_000_000n * E18);
  const c = cp("0x03", 1000n * E18, 2_002_000n * E18);
  assert.equal(quoteSplit([a, b, c], A, B), null);
});

test("a split that only matches the best single route is not reported", () => {
  // One cheap pool, one dear pool, and a third far outside the spread: the optimum is a plain 1>1 route.
  const p1 = cp("0x01", 1000n * E18, 2_100_000n * E18);
  const p2 = cp("0x02", 1000n * E18, 2_000_000n * E18);
  const p3 = cp("0x03", 1000n * E18, 2_050_000n * E18, 30_000); // 3% fee: never worth a leg
  assert.equal(quoteSplit([p1, p2, p3], A, B), null);
});

test("leg gas: a split must beat the best single route by more than its extra legs cost", () => {
  const p1 = cp("0x01", 1000n * E18, 2_100_000n * E18);
  const p2 = cp("0x02", 600n * E18, 1_255_000n * E18, 2500);
  const p3 = cp("0x03", 1500n * E18, 3_000_000n * E18);
  const free = quoteSplit([p1, p2, p3], A, B);
  assert.ok(free);
  const margin = free.profit - free.bestSingle.profit;
  // Just under the margin: still kept, and the cost is charged.
  const kept = quoteSplit([p1, p2, p3], A, B, { legCost: () => margin - 1n });
  assert.ok(kept);
  assert.equal(kept.extraLegCost, margin - 1n);
  assert.equal(kept.gain, 1n);
  // At the margin: dropped.
  assert.equal(quoteSplit([p1, p2, p3], A, B, { legCost: () => margin }), null);
});

test("greedy pruning drops a leg that does not pay for its gas", () => {
  const p1 = cp("0x01", 1000n * E18, 2_100_000n * E18);
  const p2 = cp("0x02", 900n * E18, 1_885_000n * E18, 2500);
  const p3 = cp("0x03", 1500n * E18, 3_000_000n * E18);
  const p4 = cp("0x04", 20n * E18, 41_300n * E18); // tiny, barely cheap (q* is ~2054 B/A): a dust leg
  const all = quoteSplit([p1, p2, p3, p4], A, B);
  assert.ok(all && all.buys.length === 3, "without gas every cheap pool is used");
  const legGas = (all.profit - quoteSplit([p1, p2, p3], A, B).profit) * 2n;
  const pruned = quoteSplit([p1, p2, p3, p4], A, B, { legCost: () => legGas });
  assert.ok(pruned, "the 2>1 split still pays");
  assert.deepEqual(legPools(pruned.buys), ["0x01", "0x02"]);
  assertExact(pruned);
});

test("selling side split: one cheap pool, two dear pools (1>2), Y as the start token too", () => {
  const p1 = cp("0x01", 2000n * E18, 4_200_000n * E18);
  const p2 = cp("0x02", 1000n * E18, 2_000_000n * E18);
  const p3 = cp("0x03", 800n * E18, 1_602_000n * E18, 2000);
  const q = quoteSplit([p1, p2, p3], A, B);
  assert.ok(q);
  assert.deepEqual(legPools(q.buys), ["0x01"]);
  assert.deepEqual(legPools(q.sells), ["0x02", "0x03"]);
  assertExact(q);
  within(q.profit, bruteForce([p1], [p2, p3], 120e18));
  // With B as the start token the same pools give the mirror trade (buy A on the dear pools, sell on p1).
  const mirror = findSplitTrades([p1, p2, p3], [B]);
  assert.equal(mirror.length, 1);
  assert.equal(mirror[0].tokenIn, B);
  assertExact(mirror[0]);
});

test("findSplitTrades: groups by pair, needs a start token and 3+ pools, sorted by gain", () => {
  const ps = [
    cp("0x01", 1000n * E18, 2_100_000n * E18),
    cp("0x02", 600n * E18, 1_255_000n * E18, 2500),
    cp("0x03", 1500n * E18, 3_000_000n * E18),
    // a pair without a start token is ignored
    { ...cp("0x11", 10n * E18, 21n * E18), token0: B, token1: C },
    { ...cp("0x12", 10n * E18, 20n * E18), token0: B, token1: C },
    { ...cp("0x13", 10n * E18, 20n * E18), token0: B, token1: C },
  ];
  const qs = findSplitTrades(ps, [A]);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].tokenIn, A);
  assert.equal(splitLabel(qs[0], (a) => (a === A ? "WETH" : "AERO")), "WETH/AERO split 2>1");
  // Aerodrome stable pools are not constant product: never used.
  const stable = findSplitTrades(ps.map((p) => ({ ...p, stable: p.address === "0x03" })), [A]);
  assert.equal(stable.length, 0);
});

test("evaluatePlan re-prices a split on moved reserves: shortfall cuts sells, last leg takes the rest", () => {
  const p1 = cp("0x01", 1000n * E18, 2_100_000n * E18);
  const p2 = cp("0x02", 600n * E18, 1_255_000n * E18, 2500);
  const p3 = cp("0x03", 1500n * E18, 3_000_000n * E18);
  const q = quoteSplit([p1, p2, p3], A, B);
  const plan = { buys: q.buys.map((l) => ({ pool: l.pool, amountIn: l.amountIn })), sells: q.sells.map((l) => ({ pool: l.pool, amountIn: l.amountIn })) };
  const same = evaluatePlan(A, B, plan);
  assert.equal(same.profit, q.profit);
  // Someone else bought B on p1 first: fewer B for us, the last sell takes what there is, profit drops.
  const moved = { ...p1, reserve0: p1.reserve0 + 20n * E18, reserve1: p1.reserve1 - 41_000n * E18 };
  const plan2 = { buys: plan.buys.map((b) => ({ ...b, pool: b.pool === p1 ? moved : b.pool })), sells: plan.sells };
  const later = evaluatePlan(A, B, plan2);
  assert.ok(later.profit < q.profit);
  assert.equal(later.dust, 0n);
  // Fixed amounts for every sell (no "take the rest"): surplus becomes dust, shortfall is cut.
  const fixed = evaluatePlan(A, B, plan, false);
  assert.equal(fixed.profit, q.profit);
});

test("randomised pools: every reported split is exact, inside CL ranges, and beats the best single route", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let found = 0;
  for (let k = 0; k < 150; k++) {
    const n = 3 + Math.floor(rnd() * 4);
    const pools = [];
    for (let i = 0; i < n; i++) {
      const price = 2000 * (1 + (rnd() - 0.5) * 0.08);
      const depth = 50 + rnd() * 2000;
      const addr = "0x" + (i + 1).toString(16).padStart(2, "0");
      if (rnd() < 0.4) {
        const L = BigInt(Math.floor(depth * Math.sqrt(price) * 1e6)) * 10n ** 12n;
        pools.push(clp(addr, price, L, [100, 500, 3000][Math.floor(rnd() * 3)], 1 + Math.floor(rnd() * 60), 1 + Math.floor(rnd() * 60)));
      } else {
        const rA = BigInt(Math.floor(depth * 1e6)) * 10n ** 12n;
        const rB = BigInt(Math.floor(depth * price * 1e6)) * 10n ** 12n;
        pools.push(cp(addr, rA, rB, [500, 2500, 3000, 10000][Math.floor(rnd() * 4)], rnd() < 0.3 ? "bps" : "ppm"));
      }
    }
    for (const q of findSplitTrades(pools, [A, B])) {
      found++;
      assertExact(q);
      assertCaps(q);
      assert.ok(q.buys.length + q.sells.length >= 3);
      assert.ok(q.gain > 0n && q.profit > (q.bestSingle?.profit ?? 0n));
      const buyPools = new Set(q.buys.map((l) => l.pool));
      assert.ok(q.sells.every((l) => !buyPools.has(l.pool)), "a pool is never both bought from and sold into");
    }
  }
  assert.ok(found > 20, `only ${found} splits in 150 random pool sets`);
});

test("bestSingleRoute matches routes.optimizeRoute (the existing exact two-pool sizer) to within 0.0001%", () => {
  const pools = [
    cp("0x01", 1000n * E18, 2_100_000n * E18),
    clp("0x02", 2095, 2n * 10n ** 22n, 500, 200, 200),
    cp("0x03", 1500n * E18, 3_000_000n * E18, 3000, "bps"),
    clp("0x04", 2005, 3n * 10n ** 22n, 500, 200, 200),
  ];
  const s = bestSingleRoute(pools, A, B);
  let ref = 0n;
  for (const i of pools) for (const j of pools) {
    if (i === j) continue;
    const q = optimizeRoute({ pools: [i, j], tokens: [A, B, A] });
    if (q && q.profit > ref) ref = q.profit;
  }
  assert.ok(s && ref > 0n);
  assert.ok(s.profit <= ref, "cannot beat the exact integer optimum");
  assert.ok((ref - s.profit) * 1_000_000n <= ref, `golden-section single ${s.profit} vs optimizeRoute ${ref}`);
});
