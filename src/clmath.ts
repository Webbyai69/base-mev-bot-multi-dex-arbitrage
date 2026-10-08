/**
 * Concentrated-liquidity maths (Uniswap V3 and Aerodrome Slipstream, which
 * share the same SwapMath / SqrtPriceMath / TickMath / TickBitmap code), in
 * BigInt and exact to the wei — a port of the Solidity libraries including
 * their rounding and overflow branches.
 *
 * How the bot uses it: inside one initialized-tick range a CL pool has
 * constant liquidity L and behaves exactly like a constant-product pool with
 * "virtual reserves" x = L/sqrtP, y = L*sqrtP. We only ever trade a CL pool
 * up to its next initialized tick in the swap direction (found from the pool's
 * tick bitmap), so a single swap step is exact and we never need the full
 * tick map. Swaps that would cross a tick return null and are treated as
 * infeasible by the route optimiser, which then searches a smaller size.
 *
 * No ethers import on purpose: this file is pure maths and is unit-tested
 * against the reference constants without any dependency.
 */

export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
const MAX_U256 = (1n << 256n) - 1n;
const MAX_U160 = (1n << 160n) - 1n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const PIPS = 1_000_000n;

// ---------------------------------------------------------------------------
// FullMath
// ---------------------------------------------------------------------------

export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("mulDiv by zero");
  const r = (a * b) / d;
  if (r > MAX_U256) throw new Error("mulDiv overflow");
  return r;
}

export function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  const r = mulDiv(a, b, d);
  return (a * b) % d > 0n ? r + 1n : r;
}

function divRoundingUp(a: bigint, b: bigint): bigint {
  return a / b + (a % b > 0n ? 1n : 0n);
}

// ---------------------------------------------------------------------------
// TickMath
// ---------------------------------------------------------------------------

/** Multipliers for bits 1..19 of |tick| (bit 0 is the initial value). */
const TICK_MULTIPLIERS: Array<[number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** sqrt(1.0001^tick) * 2^96, exactly as TickMath.getSqrtRatioAtTick. */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of range: ${tick}`);
  const absTick = Math.abs(tick);
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, mult] of TICK_MULTIPLIERS) {
    if ((absTick & bit) !== 0) ratio = (ratio * mult) >> 128n;
  }
  if (tick > 0) ratio = MAX_U256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// ---------------------------------------------------------------------------
// SqrtPriceMath
// ---------------------------------------------------------------------------

/** Amount of token0 between two prices: L * (sqrtB - sqrtA) / (sqrtA * sqrtB). */
export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA <= 0n) throw new Error("sqrt price must be positive");
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtB - sqrtA;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), sqrtA)
    : mulDiv(numerator1, numerator2, sqrtB) / sqrtA;
}

/** Amount of token1 between two prices: L * (sqrtB - sqrtA). */
export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? mulDivRoundingUp(liquidity, sqrtB - sqrtA, Q96) : mulDiv(liquidity, sqrtB - sqrtA, Q96);
}

/** SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp with add = true (token0 in). */
function nextSqrtFromAmount0In(sqrtP: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtP;
  const numerator1 = liquidity << 96n;
  const product = amount * sqrtP;
  // Solidity takes the first branch only when amount*sqrtP and the sum do not overflow uint256.
  if (product <= MAX_U256) {
    const denominator = numerator1 + product;
    if (denominator <= MAX_U256) return mulDivRoundingUp(numerator1, sqrtP, denominator);
  }
  return divRoundingUp(numerator1, numerator1 / sqrtP + amount);
}

/** SqrtPriceMath.getNextSqrtPriceFromAmount1RoundingDown with add = true (token1 in). */
function nextSqrtFromAmount1In(sqrtP: bigint, liquidity: bigint, amount: bigint): bigint {
  const quotient = amount <= MAX_U160 ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
  return sqrtP + quotient;
}

// ---------------------------------------------------------------------------
// TickBitmap
// ---------------------------------------------------------------------------

function msb(x: bigint): number {
  return x.toString(2).length - 1;
}

function lsb(x: bigint): number {
  let i = 0;
  while (((x >> BigInt(i)) & 1n) === 0n) i++;
  return i;
}

/** Floor division of the tick by its spacing (Solidity rounds toward zero, then adjusts negatives). */
export function compressTick(tick: number, tickSpacing: number): number {
  let c = Math.trunc(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) c--;
  return c;
}

/** Word index (int16) that holds the bit for a compressed tick. */
export function wordPosition(compressed: number): number {
  return compressed >> 8;
}

/**
 * TickBitmap.nextInitializedTickWithinOneWord. `words` holds the bitmap words
 * we fetched; a missing word returns null (we cannot tell where liquidity changes).
 * Returns the next tick at which liquidity may change and whether it is initialized.
 */
export function nextInitializedTickWithinOneWord(
  words: ReadonlyMap<number, bigint>,
  tick: number,
  tickSpacing: number,
  lte: boolean,
): { next: number; initialized: boolean } | null {
  const compressed = compressTick(tick, tickSpacing);
  if (lte) {
    const wordPos = compressed >> 8;
    const bitPos = ((compressed % 256) + 256) % 256;
    const word = words.get(wordPos);
    if (word === undefined) return null;
    const mask = (1n << BigInt(bitPos)) - 1n + (1n << BigInt(bitPos));
    const masked = word & mask;
    const initialized = masked !== 0n;
    const next = initialized ? (compressed - (bitPos - msb(masked))) * tickSpacing : (compressed - bitPos) * tickSpacing;
    return { next, initialized };
  }
  const c1 = compressed + 1;
  const wordPos = c1 >> 8;
  const bitPos = ((c1 % 256) + 256) % 256;
  const word = words.get(wordPos);
  if (word === undefined) return null;
  const mask = ~((1n << BigInt(bitPos)) - 1n) & MAX_U256;
  const masked = word & mask;
  const initialized = masked !== 0n;
  const next = initialized ? (c1 + (lsb(masked) - bitPos)) * tickSpacing : (c1 + (255 - bitPos)) * tickSpacing;
  return { next, initialized };
}

// ---------------------------------------------------------------------------
// Pool state and single-range swaps
// ---------------------------------------------------------------------------

export interface ClState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tickSpacing: number;
  /** Swap fee in pips (1e6 = 100%). Dynamic on Slipstream: re-read every block. */
  feePips: number;
  /** Tick-bitmap words we fetched for this block, keyed by word position. */
  words: Map<number, bigint>;
}

/** Bitmap words needed for both swap directions at the current tick. */
export function wordsNeeded(tick: number, tickSpacing: number): number[] {
  const c = compressTick(tick, tickSpacing);
  return [...new Set([wordPosition(c), wordPosition(c + 1)])];
}

/** The sqrt price at which this pool's liquidity may next change in the given direction. */
export function rangeBoundary(s: ClState, zeroForOne: boolean): bigint | null {
  const n = nextInitializedTickWithinOneWord(s.words, s.tick, s.tickSpacing, zeroForOne);
  if (!n) return null;
  const t = Math.min(MAX_TICK, Math.max(MIN_TICK, n.next));
  return getSqrtRatioAtTick(t);
}

export interface ClSwapResult {
  amountOut: bigint;
  sqrtPriceAfter: bigint;
}

/**
 * Exact-input swap that stays inside the current liquidity range
 * (SwapMath.computeSwapStep, exact-input branch, one step). Returns null if
 * the input would reach the range boundary, because then liquidity changes
 * and one step is no longer the whole answer.
 */
export function clSwapExactIn(s: ClState, zeroForOne: boolean, amountIn: bigint): ClSwapResult | null {
  if (amountIn <= 0n || s.liquidity <= 0n) return null;
  const target = rangeBoundary(s, zeroForOne);
  if (target === null) return null;
  const lessFee = mulDiv(amountIn, PIPS - BigInt(s.feePips), PIPS);
  const toTarget = zeroForOne ? getAmount0Delta(target, s.sqrtPriceX96, s.liquidity, true) : getAmount1Delta(s.sqrtPriceX96, target, s.liquidity, true);
  if (lessFee >= toTarget) return null;
  const sqrtNext = zeroForOne ? nextSqrtFromAmount0In(s.sqrtPriceX96, s.liquidity, lessFee) : nextSqrtFromAmount1In(s.sqrtPriceX96, s.liquidity, lessFee);
  const amountOut = zeroForOne ? getAmount1Delta(sqrtNext, s.sqrtPriceX96, s.liquidity, false) : getAmount0Delta(s.sqrtPriceX96, sqrtNext, s.liquidity, false);
  return { amountOut, sqrtPriceAfter: sqrtNext };
}

/** Largest gross input (fee included) that keeps the swap inside the current range. */
export function clMaxInput(s: ClState, zeroForOne: boolean): bigint {
  if (s.liquidity <= 0n) return 0n;
  const target = rangeBoundary(s, zeroForOne);
  if (target === null) return 0n;
  const toTarget = zeroForOne ? getAmount0Delta(target, s.sqrtPriceX96, s.liquidity, true) : getAmount1Delta(s.sqrtPriceX96, target, s.liquidity, true);
  if (toTarget <= 1n) return 0n;
  // lessFee = floor(in * (1e6 - fee) / 1e6) must stay below toTarget.
  return ((toTarget - 1n) * PIPS) / (PIPS - BigInt(s.feePips));
}

/**
 * Virtual reserves (x = L*2^96/sqrtP, y = L*sqrtP/2^96). They give the pool's
 * spot price and in-range depth, so pricing and ranking code written for
 * constant-product pools works unchanged.
 */
export function virtualReserves(s: ClState): { reserve0: bigint; reserve1: bigint } {
  if (s.sqrtPriceX96 === 0n) return { reserve0: 0n, reserve1: 0n };
  return {
    reserve0: (s.liquidity * Q96) / s.sqrtPriceX96,
    reserve1: (s.liquidity * s.sqrtPriceX96) / Q96,
  };
}
