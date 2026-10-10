/**
 * Concentrated-liquidity maths: TickMath reference values, tick-bitmap
 * lookups, and single-range swaps checked against high-precision continuous
 * formulas and the equivalent virtual-reserve constant-product pool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Q96,
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  getSqrtRatioAtTick,
  nextInitializedTickWithinOneWord,
  compressTick,
  wordsNeeded,
  clSwapExactIn,
  clMaxInput,
  virtualReserves,
  bandReserves,
} from "../dist/clmath.js";

test("getSqrtRatioAtTick matches TickMath reference values", () => {
  assert.equal(getSqrtRatioAtTick(0), Q96);
  assert.equal(getSqrtRatioAtTick(MIN_TICK), MIN_SQRT_RATIO);
  assert.equal(getSqrtRatioAtTick(MAX_TICK), MAX_SQRT_RATIO);
  // Monotonic and symmetric: sqrt(r(t)) * sqrt(r(-t)) ~= 2^192
  let prev = 0n;
  for (const t of [-500000, -100000, -12345, -1, 0, 1, 12345, 100000, 500000]) {
    const s = getSqrtRatioAtTick(t);
    assert.ok(s > prev, `not increasing at ${t}`);
    prev = s;
  }
  for (const t of [1, 60, 12345, 200000]) {
    const prod = getSqrtRatioAtTick(t) * getSqrtRatioAtTick(-t);
    const rel = Number(prod - (1n << 192n)) / 2 ** 192;
    assert.ok(Math.abs(rel) < 1e-15, `symmetry off at ${t}: ${rel}`);
  }
  // tick 1 = sqrt(1.0001) * 2^96 within float precision
  const t1 = Number(getSqrtRatioAtTick(1)) / 2 ** 96;
  assert.ok(Math.abs(t1 - Math.sqrt(1.0001)) < 1e-14);
});

test("compressTick floors toward negative infinity", () => {
  assert.equal(compressTick(65, 10), 6);
  assert.equal(compressTick(-65, 10), -7);
  assert.equal(compressTick(-60, 10), -6);
  assert.equal(compressTick(0, 60), 0);
});

test("nextInitializedTickWithinOneWord follows TickBitmap semantics", () => {
  // spacing 1, word 0 has ticks 10, 78 and 200 initialized
  const word = (1n << 10n) | (1n << 78n) | (1n << 200n);
  const words = new Map([[0, word], [-1, 0n], [1, 0n]]);
  // lte (zeroForOne): from 78 includes 78 itself
  assert.deepEqual(nextInitializedTickWithinOneWord(words, 78, 1, true), { next: 78, initialized: true });
  assert.deepEqual(nextInitializedTickWithinOneWord(words, 77, 1, true), { next: 10, initialized: true });
  assert.deepEqual(nextInitializedTickWithinOneWord(words, 9, 1, true), { next: 0, initialized: false });
  // gt (oneForZero): strictly above the current tick
  assert.deepEqual(nextInitializedTickWithinOneWord(words, 78, 1, false), { next: 200, initialized: true });
  assert.deepEqual(nextInitializedTickWithinOneWord(words, 10, 1, false), { next: 78, initialized: true });
  assert.deepEqual(nextInitializedTickWithinOneWord(words, 200, 1, false), { next: 255, initialized: false });
  // negative ticks with spacing 60: compressed -1 lives in word -1 bit 255
  const neg = new Map([[-1, 1n << 255n], [0, 0n]]);
  assert.deepEqual(nextInitializedTickWithinOneWord(neg, -30, 60, true), { next: -60, initialized: true });
  // missing word -> unknown
  assert.equal(nextInitializedTickWithinOneWord(new Map(), 5, 1, true), null);
  assert.deepEqual(wordsNeeded(255, 1), [0, 1]);
  assert.deepEqual(wordsNeeded(100, 1), [0]);
});

/** A pool at tick ~ 0 (price 1) with a wide empty bitmap: boundaries are word edges. */
function pool(overrides = {}) {
  const tick = overrides.tick ?? 3;
  return {
    sqrtPriceX96: getSqrtRatioAtTick(tick) + 12345n,
    tick,
    liquidity: 10n ** 22n,
    tickSpacing: 1,
    feePips: 500,
    words: new Map([[-1, 0n], [0, 0n], [1, 0n]]),
    ...overrides,
  };
}

/** Continuous answer with 2^64 extra precision. */
function continuousOut(s, zeroForOne, amountIn) {
  const S = 1n << 64n;
  const lessFee = (amountIn * (1_000_000n - BigInt(s.feePips))) / 1_000_000n;
  const L = s.liquidity;
  const P = s.sqrtPriceX96;
  if (zeroForOne) {
    // sqrtNext = L*P / (L + in*P/Q96); out = L*(P - sqrtNext)/Q96
    const nextS = (L * P * Q96 * S) / (L * Q96 + lessFee * P);
    return (L * (P * S - nextS)) / Q96 / S;
  }
  // sqrtNext = P + in*Q96/L; out = L*Q96*(next-P)/(next*P)
  const nextS = P * S + (lessFee * Q96 * S) / L;
  return (L * Q96 * (nextS - P * S)) / ((nextS * P) / S) / S;
}

test("clSwapExactIn matches the continuous formula to within 2 wei", () => {
  const s = pool();
  for (const zeroForOne of [true, false]) {
    const cap = clMaxInput(s, zeroForOne);
    for (const amt of [10n ** 6n, 10n ** 12n, 10n ** 15n, 10n ** 18n, cap / 2n, cap]) {
      const r = clSwapExactIn(s, zeroForOne, amt);
      assert.ok(r, `null at ${amt}`);
      const ref = continuousOut(s, zeroForOne, amt);
      const diff = ref - r.amountOut;
      assert.ok(diff >= 0n && diff <= 2n, `zeroForOne=${zeroForOne} amt=${amt}: ours ${r.amountOut} ref ${ref}`);
    }
  }
});

test("clSwapExactIn agrees with the virtual-reserve constant-product pool", () => {
  const s = pool();
  const { reserve0, reserve1 } = virtualReserves(s);
  for (const amt of [10n ** 15n, 10n ** 18n]) {
    const lessFee = (amt * (1_000_000n - 500n)) / 1_000_000n;
    const cp = (reserve1 * lessFee) / (reserve0 + lessFee);
    const cl = clSwapExactIn(s, true, amt).amountOut;
    const rel = Math.abs(Number(cp - cl)) / Number(cl);
    assert.ok(rel < 1e-12, `rel ${rel}`);
  }
});

test("clMaxInput is the exact in-range capacity", () => {
  const s = pool();
  for (const zeroForOne of [true, false]) {
    const cap = clMaxInput(s, zeroForOne);
    assert.ok(cap > 0n);
    assert.ok(clSwapExactIn(s, zeroForOne, cap), "cap itself must stay in range");
    assert.equal(clSwapExactIn(s, zeroForOne, cap + cap / 1000n + 10n), null, "beyond cap must be rejected");
  }
  // An initialized tick close by shrinks the capacity in that direction only.
  const near = pool({ words: new Map([[-1, 0n], [0, 1n << 2n], [1, 0n]]) });
  assert.ok(clMaxInput(near, true) < clMaxInput(pool(), true));
  assert.equal(clMaxInput(near, false), clMaxInput(pool(), false));
});

test("output is monotone in input and fee reduces output", () => {
  const s = pool();
  let prev = 0n;
  for (let k = 10; k <= 19; k++) {
    const out = clSwapExactIn(s, false, 10n ** BigInt(k)).amountOut;
    assert.ok(out > prev);
    prev = out;
  }
  const cheap = clSwapExactIn({ ...s, feePips: 100 }, true, 10n ** 18n).amountOut;
  const dear = clSwapExactIn({ ...s, feePips: 10000 }, true, 10n ** 18n).amountOut;
  assert.ok(cheap > dear);
});

test("bandReserves is bounded near-price depth, far below the full-curve virtual reserves", () => {
  // The value-score must rank CL pools by real usable depth. virtualReserves describe the whole
  // constant-product curve and overstate a concentrated pool by orders of magnitude; bandReserves
  // is the real ±1% in-range depth, so a deep stablecoin pool no longer scores as tens of millions.
  const s = pool(); // L = 1e22, price ~ 1
  const v = virtualReserves(s);
  const b = bandReserves(s); // default ~±1%
  assert.ok(b.reserve0 > 0n && b.reserve1 > 0n, "a live pool has near-price depth on both sides");
  assert.ok(b.reserve0 * 20n < v.reserve0, `band0 ${b.reserve0} should be << virtual0 ${v.reserve0}`);
  assert.ok(b.reserve1 * 20n < v.reserve1, `band1 ${b.reserve1} should be << virtual1 ${v.reserve1}`);
});

test("bandReserves grows with the band width and zeroes out degenerate pools", () => {
  const s = pool();
  const narrow = bandReserves(s, 10);
  const wide = bandReserves(s, 200);
  assert.ok(wide.reserve0 > narrow.reserve0 && wide.reserve1 > narrow.reserve1, "a wider band captures more depth");
  assert.deepEqual(bandReserves({ ...s, liquidity: 0n }), { reserve0: 0n, reserve1: 0n });
  assert.deepEqual(bandReserves({ ...s, sqrtPriceX96: 0n }), { reserve0: 0n, reserve1: 0n });
});
