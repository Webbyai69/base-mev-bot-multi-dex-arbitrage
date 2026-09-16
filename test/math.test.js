import { test } from "node:test";
import assert from "node:assert/strict";
import { getAmountOut, optimalAmountIn, quoteArb, isqrt, poolAmountOut } from "../dist/math.js";

const E18 = 10n ** 18n;

test("getAmountOut matches Uniswap V2 reference formula", () => {
  // Reference: amountInWithFee = in*997; out = withFee*Rout / (Rin*1000 + withFee)
  const amountIn = 1_000_000_000_000_000n; // 0.001
  const rIn = 100n * E18;
  const rOut = 250_000n * 10n ** 6n;
  const withFee = amountIn * 997n;
  const expected = (withFee * rOut) / (rIn * 1000n + withFee);
  assert.equal(getAmountOut(amountIn, rIn, rOut, 3000, "ppm"), expected);
});

test("getAmountOut bps model matches Aerodrome reference", () => {
  const amountIn = 123_456_789_000_000_000n;
  const rIn = 500n * E18;
  const rOut = 1_200_000n * 10n ** 6n;
  const fee = 30n; // 0.30% in bps
  const inAfter = amountIn - (amountIn * fee) / 10_000n;
  const expected = (inAfter * rOut) / (rIn + inAfter);
  assert.equal(getAmountOut(amountIn, rIn, rOut, 3000, "bps"), expected);
});

test("isqrt is exact", () => {
  for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 40n, 10n ** 40n + 12345n, (2n ** 200n) - 1n]) {
    const r = isqrt(n);
    assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, `isqrt(${n}) = ${r}`);
  }
});

test("optimalAmountIn is the profit maximiser (brute-force check)", () => {
  // Pool A: 100 WETH / 200,000 USDC (price 2000). Pool B: 100 WETH / 210,000 USDC (price 2100).
  // Buy WETH on A with USDC? No: tokenIn=WETH: A gives USDC at 2000, B sells USDC for WETH at 2100 -> lose.
  // Profitable direction: tokenIn = USDC... we check WETH->A->USDC->B->WETH? A: WETH->USDC at 2000/WETH,
  // B: USDC->WETH at 2100 USDC per WETH -> lose. So use tokenIn=WETH on B (get 2100 USDC) then A (USDC->WETH at 2000) -> win.
  const a = 100n * E18; // B.reserveIn (WETH)
  const b = 210_000n * 10n ** 6n; // B.reserveOut (USDC)
  const c = 200_000n * 10n ** 6n; // A.reserveIn (USDC)
  const d = 100n * E18; // A.reserveOut (WETH)
  const fee = 3000;
  const dxStar = optimalAmountIn(a, b, c, d, fee, fee);
  assert.ok(dxStar > 0n, "should be profitable");
  const profitAt = (dx) => {
    const mid = getAmountOut(dx, a, b, fee);
    const out = getAmountOut(mid, c, d, fee);
    return out - dx;
  };
  const pStar = profitAt(dxStar);
  assert.ok(pStar > 0n, "positive profit at optimum");
  // Coarse scan across a wide range must not beat the optimum by more than rounding noise.
  let bestScan = 0n;
  for (let i = 1n; i <= 400n; i++) {
    const dx = (dxStar * i) / 100n; // 1% .. 400% of optimum
    const p = profitAt(dx);
    if (p > bestScan) bestScan = p;
  }
  // Allow 0.01% tolerance for integer effects.
  assert.ok(pStar * 10_001n >= bestScan * 10_000n, `optimum ${pStar} vs scan ${bestScan}`);
  // Sanity: the optimum should be a meaningful size (roughly 1.2 WETH here).
  assert.ok(dxStar > E18 / 2n && dxStar < 3n * E18, `dx* = ${dxStar}`);
});

test("optimalAmountIn returns 0 when the spread is inside the fees", () => {
  const a = 100n * E18, b = 200_000n * 10n ** 6n, c = 200_100n * 10n ** 6n, d = 100n * E18; // 0.05% spread
  assert.equal(optimalAmountIn(a, b, c, d, 3000, 3000), 0n);
});

test("quoteArb finds the profitable direction and reports exact amounts", () => {
  const WETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const poolA = { address: "0xa", token0: WETH, token1: USDC, reserve0: 100n * E18, reserve1: 200_000n * 10n ** 6n, feePpm: 3000, feeModel: "ppm" };
  const poolB = { address: "0xb", token0: USDC, token1: WETH, reserve0: 210_000n * 10n ** 6n, reserve1: 100n * E18, feePpm: 3000, feeModel: "ppm" };
  // Sell WETH where it is dear (B), buy it back where it is cheap (A).
  const q = quoteArb(poolB, poolA, WETH);
  assert.ok(q, "expected a quote");
  assert.equal(q.tokenMid.toLowerCase(), USDC.toLowerCase());
  assert.equal(q.amountMid, poolAmountOut(poolB, WETH, q.amountIn));
  assert.equal(q.amountOut, poolAmountOut(poolA, USDC, q.amountMid));
  assert.equal(q.profit, q.amountOut - q.amountIn);
  assert.ok(q.profit > 0n);
  // The opposite direction must not be profitable.
  assert.equal(quoteArb(poolA, poolB, WETH), null);
  // Cap is respected.
  const capped = quoteArb(poolB, poolA, WETH, E18 / 10n);
  assert.ok(capped && capped.amountIn <= E18 / 10n);
});
