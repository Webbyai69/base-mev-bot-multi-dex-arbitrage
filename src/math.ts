/**
 * Constant-product AMM maths in BigInt, exact to the wei, plus the closed-form
 * optimal trade size for a two-pool arbitrage.
 *
 * Fee models
 *   "ppm"  Uniswap V2 & forks: out = in*(1e6-fee)*Rout / (Rin*1e6 + in*(1e6-fee))
 *   "bps"  Aerodrome/Velodrome volatile pools: in' = in - in*feeBps/10000,
 *          out = in'*Rout / (Rin + in')
 * Both are "fee on input", so the same closed-form optimum applies; only the
 * exact wei-level output differs, which is why the final profit is always
 * recomputed with the exact per-pool formula.
 */

export type FeeModel = "ppm" | "bps";

export const PPM = 1_000_000n;

export interface PoolLike {
  address: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  /** Fee in parts-per-million of input (3000 = 0.30%). For "bps" pools this is bps*100. */
  feePpm: number;
  feeModel: FeeModel;
}

export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePpm: number, model: FeeModel = "ppm"): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  if (model === "bps") {
    const feeBps = BigInt(Math.round(feePpm / 100));
    const inAfter = amountIn - (amountIn * feeBps) / 10_000n;
    return (inAfter * reserveOut) / (reserveIn + inAfter);
  }
  const inWithFee = amountIn * (PPM - BigInt(feePpm));
  return (inWithFee * reserveOut) / (reserveIn * PPM + inWithFee);
}

/** Output of swapping `amountIn` of `tokenIn` through `pool`. */
export function poolAmountOut(pool: PoolLike, tokenIn: string, amountIn: bigint): bigint {
  const zeroForOne = tokenIn.toLowerCase() === pool.token0.toLowerCase();
  const reserveIn = zeroForOne ? pool.reserve0 : pool.reserve1;
  const reserveOut = zeroForOne ? pool.reserve1 : pool.reserve0;
  return getAmountOut(amountIn, reserveIn, reserveOut, pool.feePpm, pool.feeModel);
}

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  // Newton's method starting from a power-of-two upper bound.
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * Closed-form optimal input for tokenIn -> buyPool -> tokenMid -> sellPool -> tokenIn.
 *
 * With a = buy.reserveIn, b = buy.reserveOut, c = sell.reserveIn, d = sell.reserveOut
 * and RA/RB = (1e6 - fee) in ppm:
 *   dx* = (sqrt(RA*RB*a*b*c*d) - 1e6*a*c) * 1e6 / (RA * (1e6*c + RB*b))
 * Returns 0n when no positive-profit trade exists.
 */
export function optimalAmountIn(a: bigint, b: bigint, c: bigint, d: bigint, feeBuyPpm: number, feeSellPpm: number): bigint {
  if (a <= 0n || b <= 0n || c <= 0n || d <= 0n) return 0n;
  const RA = PPM - BigInt(feeBuyPpm);
  const RB = PPM - BigInt(feeSellPpm);
  const root = isqrt(RA * RB * a * b * c * d);
  const numerator = root - PPM * a * c;
  if (numerator <= 0n) return 0n;
  const denominator = RA * (PPM * c + RB * b);
  return (numerator * PPM) / denominator;
}

export interface ArbQuote {
  buyPool: PoolLike;
  sellPool: PoolLike;
  tokenIn: string;
  tokenMid: string;
  amountIn: bigint;
  amountMid: bigint;
  amountOut: bigint;
  /** amountOut - amountIn, in tokenIn units. */
  profit: bigint;
}

/**
 * Best arbitrage for one direction (tokenIn is bought-with on buyPool, the
 * received tokenMid is sold on sellPool for tokenIn). Exact profit is
 * recomputed with the discrete formulas and refined around the continuous
 * optimum, and capped at `maxAmountIn` when given.
 */
export function quoteArb(buyPool: PoolLike, sellPool: PoolLike, tokenIn: string, maxAmountIn?: bigint): ArbQuote | null {
  const tin = tokenIn.toLowerCase();
  const buyZeroForOne = tin === buyPool.token0.toLowerCase();
  const tokenMid = buyZeroForOne ? buyPool.token1 : buyPool.token0;
  const a = buyZeroForOne ? buyPool.reserve0 : buyPool.reserve1;
  const b = buyZeroForOne ? buyPool.reserve1 : buyPool.reserve0;
  const sellZeroForOne = tokenMid.toLowerCase() === sellPool.token0.toLowerCase();
  const c = sellZeroForOne ? sellPool.reserve0 : sellPool.reserve1;
  const d = sellZeroForOne ? sellPool.reserve1 : sellPool.reserve0;

  let dx = optimalAmountIn(a, b, c, d, buyPool.feePpm, sellPool.feePpm);
  if (dx <= 0n) return null;
  if (maxAmountIn !== undefined && dx > maxAmountIn) dx = maxAmountIn;

  const evaluate = (amountIn: bigint): ArbQuote => {
    const amountMid = poolAmountOut(buyPool, tokenIn, amountIn);
    const amountOut = poolAmountOut(sellPool, tokenMid, amountMid);
    return { buyPool, sellPool, tokenIn, tokenMid, amountIn, amountMid, amountOut, profit: amountOut - amountIn };
  };

  // The continuous optimum is within rounding of the discrete one; probe a few
  // neighbours in case the cap or integer rounding shifted it.
  let best = evaluate(dx);
  for (const f of [990n, 995n, 1005n, 1010n]) {
    const cand = (dx * f) / 1000n;
    if (cand <= 0n || (maxAmountIn !== undefined && cand > maxAmountIn)) continue;
    const q = evaluate(cand);
    if (q.profit > best.profit) best = q;
  }
  return best.profit > 0n ? best : null;
}

/** Spot price of token1 in token0 units as a float (for display / ranking only). */
export function spotPrice(reserveIn: bigint, reserveOut: bigint, decimalsIn: number, decimalsOut: number): number {
  if (reserveIn === 0n) return 0;
  const num = Number(reserveOut) / 10 ** decimalsOut;
  const den = Number(reserveIn) / 10 ** decimalsIn;
  return den === 0 ? 0 : num / den;
}

export function formatUnits(value: bigint, decimals: number, precision = 6): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, precision);
  fracStr = fracStr.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${fracStr ? "." + fracStr : ""}`;
}

export function toFloat(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}
