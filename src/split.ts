/**
 * Split-trade optimiser: when one token pair (X, Y) trades on three or more
 * pools, buy Y from several cheap pools at once and sell it into one or more
 * dear pools, all at a common marginal price.
 *
 *   X --buy pool 1--> Y \
 *   X --buy pool 2--> Y  >-- Y --sell pool 3--> X
 *                        \-- Y --sell pool 4--> X
 *
 * Continuous model (fee on input, constant product on real or virtual
 * reserves; r = 1 - fee). Paying d of the input into a pool with input
 * reserve a and output reserve b gives out(d) = r*d*b / (a + r*d), and the
 * marginal output per unit of input after paying d is r*a*b / (a + r*d)^2.
 * For a target marginal rate rho the input that moves the pool there is
 *   d(rho) = (sqrt(r*a*b / rho) - a) / r          (clamped to [0, cap])
 * With q = marginal price of Y in X, a buy pool runs at rho = 1/q and a sell
 * pool at rho = q. B(q) = Y bought from every pool cheaper than q rises with
 * q; S(q) = Y sold into every pool dearer than q falls with q. Bisecting for
 * B(q*) = S(q*) gives the optimum of the concave problem
 *   max  sum_j sellOut_j(y_j) - sum_i x_i   s.t.  sum_i buyOut_i(x_i) = sum_j y_j
 * (the Lagrange condition is exactly "every active leg at the same marginal
 * price"). Concentrated-liquidity pools in range are constant-product pools
 * on virtual reserves (L/sqrtP, L*sqrtP), capped at clMaxInput so a leg never
 * crosses an initialized tick.
 *
 * Exact stage. Integer buy inputs are run through the exact per-pool
 * functions (routes.hopOut: Uniswap V2 / Aerodrome volatile / CL single
 * step, wei-exact). The Y actually bought is shared over the sells in
 * proportion to their continuous amounts; the last sell (the deepest
 * uncapped one) takes the exact remainder, so no Y is left in the contract
 * (dust is reported and is zero unless every sell hits its cap). A 1-D
 * golden-section search on an overall scale factor polishes the result
 * against the exact functions. The reported profit is always the exact
 * re-evaluation of the reported legs; nothing is estimated.
 *
 * A split is kept only when its exact profit minus the gas for its extra
 * legs (opts.legCost) beats the best single buy-pool/sell-pool route on the
 * same pools (routes.optimizeRoute, also exact). Legs that don't pay for
 * their gas are pruned greedily.
 *
 * Pure maths, no ethers import (like routes.ts and clmath.ts).
 */
import { clMaxInput, virtualReserves } from "./clmath.js";
import { hopOut, type RoutePool } from "./routes.js";

export interface Leg<P extends RoutePool = RoutePool> {
  pool: P;
  amountIn: bigint;
  amountOut: bigint;
}

export interface SplitQuote<P extends RoutePool = RoutePool> {
  /** Start token X (borrowed, profit token). */
  tokenIn: string;
  /** The other token Y. */
  tokenMid: string;
  /** X -> Y legs, executed first. */
  buys: Leg<P>[];
  /** Y -> X legs, executed after the buys; the last one sells the remaining Y balance. */
  sells: Leg<P>[];
  /** Sum of buy inputs (X). */
  amountIn: bigint;
  /** Y received from the buys. */
  amountMid: bigint;
  /** Y bought but not sold (left in the contract, valued at zero). Zero unless every sell is capped. */
  dust: bigint;
  /** X received from the sells. */
  amountOut: bigint;
  /** amountOut - amountIn, exact. */
  profit: bigint;
  /** Gas for the legs beyond a plain two-pool route, in X (opts.legCost x (legs - 2)). */
  extraLegCost: bigint;
  /** Best single buy/sell two-pool route on the same pools (exact), or null if none is profitable. */
  bestSingle: { buy: P; sell: P; amountIn: bigint; profit: bigint } | null;
  /** profit - extraLegCost - bestSingle.profit: what the split adds. Always > 0 for returned quotes. */
  gain: bigint;
  /** Common marginal price of Y in X at the continuous optimum (display only). */
  marginalPrice: number;
}

export interface SplitOptions {
  /** Gas cost of one extra swap leg, in units of the given start token. Default 0. */
  legCost?: (token: string) => bigint;
  /** Deepest pools per pair considered (by X-side reserve). Default 8. */
  maxPoolsPerPair?: number;
  /** Stop starting new pairs after this wall-clock time (ms since epoch). */
  deadline?: number;
  /** Skip pools for which this returns true (e.g. blocked tokens). */
  exclude?: (p: RoutePool) => boolean;
}

// ---------------------------------------------------------------------------
// Continuous model
// ---------------------------------------------------------------------------

/** One swap direction of one pool, as floats. */
export interface Side {
  /** Input-side reserve (real or virtual). */
  a: number;
  /** Output-side reserve. */
  b: number;
  /** 1 - fee. */
  r: number;
  /** Largest gross input that stays exact (CL in-range capacity); Infinity for constant-product pools. */
  cap: number;
  capBig: bigint | null;
}

interface Model<P extends RoutePool> {
  pool: P;
  /** X in, Y out. */
  buy: Side;
  /** Y in, X out. */
  sell: Side;
}

/** Input that brings this side's marginal output-per-input down to `rate` (0 if already below). */
export function inputAtRate(s: Side, rate: number): number {
  if (!(rate > 0)) return s.cap;
  const d = (Math.sqrt((s.r * s.a * s.b) / rate) - s.a) / s.r;
  if (!(d > 0)) return 0;
  return d > s.cap ? s.cap : d;
}

export function outputFor(s: Side, d: number): number {
  return d > 0 ? (s.r * d * s.b) / (s.a + s.r * d) : 0;
}

/** Marginal output per unit input at zero size (spot rate after fee). */
export function spotRate(s: Side): number {
  return (s.r * s.b) / s.a;
}

function feeOf(p: RoutePool): number {
  return p.cl ? p.cl.feePips : p.feePpm;
}

function modelOf<P extends RoutePool>(p: P, x: string): Model<P> | null {
  const fee = feeOf(p);
  if (!(fee >= 0 && fee < 1_000_000)) return null;
  const r = 1 - fee / 1_000_000;
  let r0 = p.reserve0;
  let r1 = p.reserve1;
  if (p.cl) {
    if (p.cl.liquidity <= 0n) return null;
    const v = virtualReserves(p.cl);
    r0 = v.reserve0;
    r1 = v.reserve1;
  }
  if (r0 <= 0n || r1 <= 0n) return null;
  const xIs0 = p.token0 === x;
  const rx = Number(xIs0 ? r0 : r1);
  const ry = Number(xIs0 ? r1 : r0);
  const capOf = (zeroForOne: boolean): bigint | null => (p.cl ? clMaxInput(p.cl, zeroForOne) : null);
  const capBuy = capOf(xIs0);
  const capSell = capOf(!xIs0);
  const side = (a: number, b: number, capBig: bigint | null): Side => ({ a, b, r, cap: capBig === null ? Infinity : Number(capBig), capBig });
  return { pool: p, buy: side(rx, ry, capBuy), sell: side(ry, rx, capSell) };
}

interface Continuous<P extends RoutePool> {
  q: number;
  buys: Array<{ m: Model<P>; d: number }>;
  sells: Array<{ m: Model<P>; d: number }>;
}

/**
 * Common marginal price q* where Y bought (pools cheaper than q) equals Y
 * sold (pools dearer than q), by bisection on log q. Null when no pool is
 * cheaper than another pool is dear (no spread after fees).
 */
export function solveContinuous<P extends RoutePool>(models: Model<P>[]): Continuous<P> | null {
  // A pool buys below q when its spot cost 1/spotRate(buy) < q, and sells above q when spotRate(sell) > q.
  let lo = Infinity;
  let hi = 0;
  for (const m of models) {
    if (m.buy.cap > 0) lo = Math.min(lo, 1 / spotRate(m.buy));
    if (m.sell.cap > 0) hi = Math.max(hi, spotRate(m.sell));
  }
  if (!(lo < hi) || !Number.isFinite(lo)) return null;
  const B = (q: number) => models.reduce((s, m) => s + outputFor(m.buy, inputAtRate(m.buy, 1 / q)), 0);
  const S = (q: number) => models.reduce((s, m) => s + inputAtRate(m.sell, q), 0);
  let l = Math.log(lo);
  let h = Math.log(hi);
  for (let i = 0; i < 200 && h - l > 1e-15; i++) {
    const mid = (l + h) / 2;
    const q = Math.exp(mid);
    if (B(q) < S(q)) l = mid;
    else h = mid;
  }
  const q = Math.exp((l + h) / 2);
  const buys = models.map((m) => ({ m, d: inputAtRate(m.buy, 1 / q) })).filter((x) => x.d > 0);
  const sells = models.map((m) => ({ m, d: inputAtRate(m.sell, q) })).filter((x) => x.d > 0);
  if (!buys.length || !sells.length) return null;
  return { q, buys, sells };
}

// ---------------------------------------------------------------------------
// Exact evaluation
// ---------------------------------------------------------------------------

const NEG = -(1n << 255n);

function toBig(x: number): bigint {
  if (!(x > 0) || !Number.isFinite(x)) return 0n;
  return BigInt(Math.floor(x));
}

export interface ExactPlan<P extends RoutePool> {
  buys: Array<{ pool: P; amountIn: bigint }>;
  /** Sell legs in execution order; the last one's amount is "whatever Y is left". */
  sells: Array<{ pool: P; amountIn: bigint }>;
}

/**
 * Run a plan exactly. Buys at their stated inputs; sells at their stated
 * inputs except the last, which sells the remaining Y. If the Y bought falls
 * short of the stated sells (re-pricing on a later block), earlier sells are
 * cut to what is available. Returns null if any leg is infeasible (empty
 * output, CL range crossed). With `lastTakesRest = false` every sell uses its
 * stated amount and any surplus Y is dust.
 */
export function evaluatePlan<P extends RoutePool>(x: string, y: string, plan: ExactPlan<P>, lastTakesRest = true): Omit<SplitQuote<P>, "extraLegCost" | "bestSingle" | "gain" | "marginalPrice"> | null {
  const buys: Leg<P>[] = [];
  let amountIn = 0n;
  let amountMid = 0n;
  for (const b of plan.buys) {
    if (b.amountIn <= 0n) continue;
    const out = hopOut(b.pool, x, b.amountIn);
    if (out === null) return null;
    buys.push({ pool: b.pool, amountIn: b.amountIn, amountOut: out });
    amountIn += b.amountIn;
    amountMid += out;
  }
  if (!buys.length) return null;
  const sells: Leg<P>[] = [];
  let left = amountMid;
  let amountOut = 0n;
  for (let i = 0; i < plan.sells.length && left > 0n; i++) {
    const s = plan.sells[i]!;
    const last = i === plan.sells.length - 1;
    const amt = last && lastTakesRest ? left : s.amountIn < left ? s.amountIn : left;
    if (amt <= 0n) continue;
    const out = hopOut(s.pool, y, amt);
    if (out === null) return null;
    sells.push({ pool: s.pool, amountIn: amt, amountOut: out });
    left -= amt;
    amountOut += out;
  }
  if (!sells.length) return null;
  return { tokenIn: x, tokenMid: y, buys, sells, amountIn, amountMid, dust: left, amountOut, profit: amountOut - amountIn };
}

type Exact<P extends RoutePool> = NonNullable<ReturnType<typeof evaluatePlan<P>>>;

/**
 * Exact split at overall scale `s` of the continuous solution, in one pass.
 * Buy inputs are scaled and clamped at their CL caps; the exact Y they
 * return is shared over the sells by their continuous weights (capped legs
 * clamped), and the deepest uncapped sell goes last and takes the remainder.
 * Null if any leg is infeasible or a CL leg would leave its range.
 */
function exactAt<P extends RoutePool>(x: string, y: string, c: Continuous<P>, order: Continuous<P>["sells"], wSum: number, s: number): Exact<P> | null {
  const buys: Leg<P>[] = [];
  let amountIn = 0n;
  let amountMid = 0n;
  for (const { m, d } of c.buys) {
    let amt = toBig(d * s);
    if (m.buy.capBig !== null && amt > m.buy.capBig) amt = m.buy.capBig;
    if (amt <= 0n) continue;
    const out = hopOut(m.pool, x, amt);
    if (out === null) return null;
    buys.push({ pool: m.pool, amountIn: amt, amountOut: out });
    amountIn += amt;
    amountMid += out;
  }
  if (!buys.length) return null;
  const sells: Leg<P>[] = [];
  let left = amountMid;
  let amountOut = 0n;
  for (let i = 0; i < order.length && left > 0n; i++) {
    const { m, d } = order[i]!;
    let amt: bigint;
    if (i === order.length - 1) {
      amt = left;
      if (m.sell.capBig !== null && amt > m.sell.capBig) return null; // the absorber would leave its range
    } else {
      // Share by weight with a 1e12 fixed-point fraction; the remainder goes to the last leg.
      amt = (amountMid * BigInt(Math.floor((d / wSum) * 1e12))) / 1_000_000_000_000n;
      if (m.sell.capBig !== null && amt > m.sell.capBig) amt = m.sell.capBig;
      if (amt > left) amt = left;
    }
    if (amt <= 0n) continue;
    const out = hopOut(m.pool, y, amt);
    if (out === null) return null;
    sells.push({ pool: m.pool, amountIn: amt, amountOut: out });
    left -= amt;
    amountOut += out;
  }
  if (!sells.length) return null;
  return { tokenIn: x, tokenMid: y, buys, sells, amountIn, amountMid, dust: left, amountOut, profit: amountOut - amountIn };
}

/** Exact split for a fixed continuous solution: golden-section search on the overall scale. */
function exactFromContinuous<P extends RoutePool>(x: string, y: string, c: Continuous<P>): Exact<P> | null {
  // Absorber (largest uncapped sell, else largest) last.
  const order = [...c.sells].sort((u, v) => (u.m.sell.capBig === null ? 1 : 0) - (v.m.sell.capBig === null ? 1 : 0) || u.d - v.d);
  const wSum = order.reduce((t, e) => t + e.d, 0);
  const at = (s: number): Exact<P> | null => exactAt(x, y, c, order, wSum, s);
  const val = (q: Exact<P> | null): bigint => (q ? q.profit : NEG);
  let best = at(1);
  // Golden-section on s in [0.5, 1.5]; profit is unimodal in s near the continuous optimum.
  const g = (Math.sqrt(5) - 1) / 2;
  let lo = 0.5;
  let hi = 1.5;
  let s1 = hi - g * (hi - lo);
  let s2 = lo + g * (hi - lo);
  let q1 = at(s1);
  let q2 = at(s2);
  for (let i = 0; i < 60 && hi - lo > 1e-9; i++) {
    if (val(q1) < val(q2)) {
      lo = s1;
      s1 = s2;
      q1 = q2;
      s2 = lo + g * (hi - lo);
      q2 = at(s2);
    } else {
      hi = s2;
      s2 = s1;
      q2 = q1;
      s1 = hi - g * (hi - lo);
      q1 = at(s1);
    }
  }
  for (const q of [q1, q2]) if (val(q) > val(best)) best = q;
  return best && best.profit > 0n ? best : null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Float profit (in X) of a continuous solution: X from the sells minus X into the buys. */
function continuousProfit<P extends RoutePool>(c: Continuous<P>): number {
  let p = 0;
  for (const s of c.sells) p += outputFor(s.m.sell, s.d);
  for (const b of c.buys) p -= b.d;
  return p;
}

/** Candidate single routes (one buy pool, one sell pool) ranked by continuous profit, best first. */
function singleCandidates<P extends RoutePool>(models: Model<P>[]): Array<{ c: Continuous<P>; p: number }> {
  const out: Array<{ c: Continuous<P>; p: number }> = [];
  for (const mi of models) {
    for (const mj of models) {
      // Marginal pruning: buying at i and selling at j needs spot cost < spot revenue.
      if (mi === mj || !(1 / spotRate(mi.buy) < spotRate(mj.sell))) continue;
      const c = solveContinuous([mi, mj]);
      if (c && c.buys.length === 1 && c.sells.length === 1 && c.buys[0]!.m === mi) out.push({ c, p: continuousProfit(c) });
    }
  }
  return out.sort((u, v) => v.p - u.p);
}

/**
 * Best exact single two-pool route (buy on one pool, sell on another) among
 * `pools`. The top `exactTop` candidates by continuous profit are sized
 * exactly (same golden-section polish as the split, which lands within a few
 * wei of the integer optimum; see test/split.test.js).
 */
export function bestSingleRoute<P extends RoutePool>(pools: P[], x: string, y: string, exactTop = 3): SplitQuote<P>["bestSingle"] {
  const models = pools.map((p) => modelOf(p, x)).filter((m): m is Model<P> => m !== null);
  return bestSingleOf(models, x, y, exactTop);
}

function bestSingleOf<P extends RoutePool>(models: Model<P>[], x: string, y: string, exactTop: number): SplitQuote<P>["bestSingle"] {
  let best: SplitQuote<P>["bestSingle"] = null;
  for (const { c } of singleCandidates(models).slice(0, exactTop)) {
    const e = exactFromContinuous(x, y, c);
    if (e && (!best || e.profit > best.profit)) best = { buy: e.buys[0]!.pool, sell: e.sells[0]!.pool, amountIn: e.amountIn, profit: e.profit };
  }
  return best;
}

function legsOf(q: { buys: unknown[]; sells: unknown[] }): number {
  return q.buys.length + q.sells.length;
}

/**
 * Best split trade for one pair and start token over `pools` (all must hold
 * both x and y). Returns null when no split with three or more legs beats
 * the best single route by more than the extra legs' gas.
 *
 * Cost: leg pruning and the comparison with single routes run on the
 * continuous model (microseconds); only the final split and the top single
 * routes are evaluated exactly.
 */
export function quoteSplit<P extends RoutePool>(pools: P[], x: string, y: string, opts: SplitOptions = {}): SplitQuote<P> | null {
  const legCost = opts.legCost?.(x) ?? 0n;
  const legCostF = Number(legCost);
  const models = pools.map((p) => modelOf(p, x)).filter((m): m is Model<P> => m !== null);
  if (models.length < 3) return null;

  const netC = (c: Continuous<P>): number => continuousProfit(c) - legCostF * (legsOf(c) - 2);
  const first = solveContinuous(models);
  if (!first || legsOf(first) < 3) return null;
  let cur: Continuous<P> = first;
  // Greedy pruning on the continuous model: drop the leg whose removal most improves profit net of leg gas.
  while (legCostF > 0 && legsOf(cur) > 3) {
    const used: Set<Model<P>> = new Set([...cur.buys, ...cur.sells].map((l) => l.m));
    let bestAlt: Continuous<P> | null = null;
    for (const m of used) {
      const alt: Continuous<P> | null = solveContinuous([...used].filter((u) => u !== m));
      if (alt && legsOf(alt) >= 3 && (!bestAlt || netC(alt) > netC(bestAlt))) bestAlt = alt;
    }
    if (bestAlt && netC(bestAlt) > netC(cur)) cur = bestAlt;
    else break;
  }
  // Cheap reject: the continuous split can't beat the continuous best single route (with slack for rounding).
  const singles = singleCandidates(models);
  const singleC = singles[0]?.p ?? 0;
  const slack = 1e-9 * Math.abs(singleC) + 1e-9 * Math.abs(continuousProfit(cur)) + 1;
  if (netC(cur) <= singleC - slack) return null;

  const e = exactFromContinuous(x, y, cur);
  if (!e || legsOf(e) < 3) return null;
  const extraLegCost = legCost * BigInt(legsOf(e) - 2);
  const bestSingle = bestSingleOf(models, x, y, 3);
  const gain = e.profit - extraLegCost - (bestSingle?.profit ?? 0n);
  if (gain <= 0n) return null;
  return { ...e, extraLegCost, bestSingle, gain, marginalPrice: cur.q };
}

function usable(p: RoutePool): boolean {
  if ((p as { stable?: boolean }).stable) return false; // Aerodrome stable curve is not constant product
  if (p.cl) return p.cl.liquidity > 0n;
  return p.reserve0 > 0n && p.reserve1 > 0n;
}

/**
 * Split trades over every pair that has a start token and three or more
 * pools. Sorted by gain over the best single route, best first.
 */
export function findSplitTrades<P extends RoutePool>(pools: Iterable<P>, startTokens: string[], opts: SplitOptions = {}): SplitQuote<P>[] {
  const starts = new Set(startTokens.map((t) => t.toLowerCase()));
  const groups = new Map<string, P[]>();
  for (const p of pools) {
    if (!usable(p) || opts.exclude?.(p)) continue;
    if (!starts.has(p.token0) && !starts.has(p.token1)) continue;
    const k = p.token0 < p.token1 ? `${p.token0}-${p.token1}` : `${p.token1}-${p.token0}`;
    const g = groups.get(k);
    if (g) g.push(p);
    else groups.set(k, [p]);
  }
  const maxPools = opts.maxPoolsPerPair ?? 8;
  const out: SplitQuote<P>[] = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    if (opts.deadline !== undefined && Date.now() > opts.deadline) break;
    const t0 = g[0]!.token0;
    const t1 = g[0]!.token1;
    for (const x of [t0, t1]) {
      if (!starts.has(x)) continue;
      const y = x === t0 ? t1 : t0;
      const depth = (p: P) => (p.token0 === x ? p.reserve0 : p.reserve1);
      const ps = g.length > maxPools ? [...g].sort((a, b) => (depth(b) > depth(a) ? 1 : depth(b) < depth(a) ? -1 : 0)).slice(0, maxPools) : g;
      const q = quoteSplit(ps, x, y, opts);
      if (q) out.push(q);
    }
  }
  out.sort((a, b) => (b.gain > a.gain ? 1 : b.gain < a.gain ? -1 : 0));
  return out;
}

/** Short label such as "WETH/AERO split 2>1" (buys > sells). */
export function splitLabel(q: { tokenIn: string; tokenMid: string; buys: unknown[]; sells: unknown[] }, symbol: (a: string) => string): string {
  return `${symbol(q.tokenIn)}/${symbol(q.tokenMid)} split ${q.buys.length}>${q.sells.length}`;
}
