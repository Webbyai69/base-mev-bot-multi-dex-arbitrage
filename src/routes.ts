/**
 * Multi-hop arbitrage routes: cycle search over the pool graph and an exact
 * optimiser for the input size.
 *
 *   start token --pool1--> A --pool2--> (B --pool3-->) start token
 *
 * Every hop is evaluated with the exact on-chain formula for its pool type
 * (Uniswap-V2 style, Aerodrome volatile, or a concentrated-liquidity pool
 * inside its current tick range), so the profit we report is the wei-level
 * answer, not an estimate. Concentrated-liquidity hops that would cross an
 * initialized tick are infeasible; the optimiser finds the largest feasible
 * size first and then maximises profit below it.
 *
 * Search is pruned with marginal rates: a cycle can only be profitable if the
 * product of (spot price x (1 - fee)) along it exceeds 1, so we enumerate
 * with log-rates and only optimise cycles whose marginal log-rate sum is
 * positive.
 *
 * Pure maths, no ethers import (unit-tested without dependencies).
 */
import { poolAmountOut, type PoolLike } from "./math.js";
import { clSwapExactIn, clMaxInput, type ClState } from "./clmath.js";

export interface RoutePool extends PoolLike {
  dex: string;
  /** Present for concentrated-liquidity pools (Uniswap V3, Slipstream). */
  cl?: ClState;
}

export interface Route<P extends RoutePool = RoutePool> {
  pools: P[];
  /** tokens[i] -> pools[i] -> tokens[i+1]; tokens[0] === tokens[last]. */
  tokens: string[];
}

export interface RouteQuote<P extends RoutePool = RoutePool> extends Route<P> {
  /** amounts[0] is the input, amounts[i+1] the output of hop i. */
  amounts: bigint[];
  profit: bigint;
}

/** Exact output of one hop, or null if infeasible (CL range crossed, empty pool). */
export function hopOut(pool: RoutePool, tokenIn: string, amountIn: bigint): bigint | null {
  if (amountIn <= 0n) return null;
  if (pool.cl) {
    const zeroForOne = tokenIn === pool.token0;
    const r = clSwapExactIn(pool.cl, zeroForOne, amountIn);
    return r ? r.amountOut : null;
  }
  const out = poolAmountOut(pool, tokenIn, amountIn);
  return out > 0n ? out : null;
}

/** Run the route at a given input; null if any hop is infeasible. */
export function evaluateRoute<P extends RoutePool>(route: Route<P>, amountIn: bigint): RouteQuote<P> | null {
  const amounts: bigint[] = [amountIn];
  let amt = amountIn;
  for (let i = 0; i < route.pools.length; i++) {
    const out = hopOut(route.pools[i]!, route.tokens[i]!, amt);
    if (out === null) return null;
    amounts.push(out);
    amt = out;
  }
  return { ...route, amounts, profit: amt - amountIn };
}

/** Marginal log-rate of swapping tokenIn through the pool (log(price * (1 - fee))). */
export function logRate(pool: RoutePool, tokenIn: string): number {
  const zeroForOne = tokenIn === pool.token0;
  const rin = Number(zeroForOne ? pool.reserve0 : pool.reserve1);
  const rout = Number(zeroForOne ? pool.reserve1 : pool.reserve0);
  if (!(rin > 0) || !(rout > 0)) return -Infinity;
  const fee = pool.cl ? pool.cl.feePips : pool.feePpm;
  if (fee < 0 || fee >= 1_000_000) return -Infinity;
  return Math.log(rout / rin) + Math.log1p(-fee / 1_000_000);
}

/**
 * Upper bound on input for the first hop: half the first pool's input-side
 * reserve (a cycle never profits from moving one pool by more than that) and,
 * for CL pools, the in-range capacity.
 */
function initialUpperBound(route: Route): bigint {
  const p = route.pools[0]!;
  const zeroForOne = route.tokens[0] === p.token0;
  const rin = zeroForOne ? p.reserve0 : p.reserve1;
  let hi = rin / 2n;
  if (p.cl) {
    const cap = clMaxInput(p.cl, zeroForOne);
    if (cap < hi) hi = cap;
  }
  return hi;
}

/**
 * Best input size for the route: largest feasible input by bisection
 * (feasibility is monotone in size), then ternary search on the profit, which
 * is concave in the input for a chain of constant-product/in-range CL hops.
 * Returns null when no positive-profit size exists.
 *
 * Both searches stop at about one part in a million of the size range instead
 * of narrowing to the wei: near the optimum profit is flat (the loss is of the
 * order of the square of the size error), so the last ~20 halvings changed
 * nothing but cost most of the BigInt work. Whatever size is chosen, the
 * amounts returned are the exact on-chain outputs at that size.
 */
export function optimizeRoute<P extends RoutePool>(route: Route<P>, maxAmountIn?: bigint): RouteQuote<P> | null {
  let hi = initialUpperBound(route);
  if (maxAmountIn !== undefined && maxAmountIn < hi) hi = maxAmountIn;
  if (hi <= 1n) return null;
  if (!evaluateRoute(route, hi)) {
    let lo = 0n;
    let top = hi;
    const step = hi >> 24n > 1n ? hi >> 24n : 1n;
    for (let i = 0; i < 128 && top - lo > step; i++) {
      const mid = (lo + top) / 2n;
      if (evaluateRoute(route, mid)) lo = mid;
      else top = mid;
    }
    hi = lo;
    if (hi <= 1n) return null;
  }
  const profitAt = (x: bigint): bigint => {
    const q = evaluateRoute(route, x);
    return q ? q.profit : -(1n << 255n);
  };
  const tol = hi >> 20n > 2n ? hi >> 20n : 2n;
  let lo = 1n;
  let top = hi;
  for (let i = 0; i < 300 && top - lo > tol; i++) {
    const m1 = lo + (top - lo) / 3n;
    const m2 = top - (top - lo) / 3n;
    if (profitAt(m1) < profitAt(m2)) lo = m1;
    else top = m2;
  }
  let best: RouteQuote<P> | null = null;
  for (const x of new Set([lo, (lo + top) / 2n, top])) {
    const q = evaluateRoute(route, x);
    if (q && (!best || q.profit > best.profit)) best = q;
  }
  return best && best.profit > 0n ? best : null;
}

interface Edge<P> {
  pool: P;
  to: string;
  rate: number;
}

export interface CycleSearchOptions {
  /** Tokens a cycle may start and end in (we must be able to borrow and price them). */
  startTokens: string[];
  /** 2 = two-pool routes only, 3 = also triangular. */
  maxHops: 2 | 3;
  /** Skip cycles that pass this predicate (e.g. pure V2 two-pool routes handled elsewhere). */
  exclude?: (pools: RoutePool[]) => boolean;
  /** Minimum marginal log-rate sum before a cycle is optimised (0 = any positive edge). */
  minLogEdge?: number;
  /** Cap on cycles returned (best marginal edge first). */
  maxCycles?: number;
  /** Counts what the search skipped: the same cycle reached again from another start token. */
  stats?: { rotations: number };
}

/**
 * One key per directed cycle, whichever token it is read from: WETH>USDC>X>WETH and
 * USDC>X>WETH>USDC are the same trade through the same pools in the same direction.
 * Each hop is (pool, token in); the list is rotated to start at the smallest pool address.
 */
export function cycleKey(pools: Array<{ address: string }>, tokens: string[]): string {
  const hops = pools.map((p, i) => `${p.address}:${tokens[i]}`);
  let k = 0;
  for (let i = 1; i < hops.length; i++) if (hops[i]! < hops[k]!) k = i;
  return [...hops.slice(k), ...hops.slice(0, k)].join(">");
}

/**
 * Enumerate candidate cycles whose marginal rate product exceeds 1. The
 * returned routes are not yet sized; pass them to optimizeRoute.
 */
export function findCycles<P extends RoutePool>(pools: Iterable<P>, opts: CycleSearchOptions): Array<Route<P> & { logEdge: number }> {
  const adj = new Map<string, Edge<P>[]>();
  const add = (from: string, e: Edge<P>) => {
    const arr = adj.get(from);
    if (arr) arr.push(e);
    else adj.set(from, [e]);
  };
  for (const p of pools) {
    if (p.reserve0 <= 0n || p.reserve1 <= 0n) continue;
    if (p.cl && p.cl.liquidity <= 0n) continue;
    const r01 = logRate(p, p.token0);
    const r10 = logRate(p, p.token1);
    if (Number.isFinite(r01)) add(p.token0, { pool: p, to: p.token1, rate: r01 });
    if (Number.isFinite(r10)) add(p.token1, { pool: p, to: p.token0, rate: r10 });
  }
  const minEdge = opts.minLogEdge ?? 0;
  const out: Array<Route<P> & { logEdge: number }> = [];
  const seen = new Set<string>();

  for (const start of opts.startTokens) {
    const first = adj.get(start) ?? [];
    // Best edge from each token back to `start`, for pruning three-hop cycles.
    const bestBack = new Map<string, number>();
    for (const [tok, edges] of adj) {
      let b = -Infinity;
      for (const e of edges) if (e.to === start && e.rate > b) b = e.rate;
      if (b > -Infinity) bestBack.set(tok, b);
    }
    for (const e1 of first) {
      const a = e1.to;
      if (a === start) continue;
      for (const e2 of adj.get(a) ?? []) {
        if (e2.pool === e1.pool) continue;
        // Two-hop: start -> a -> start
        if (e2.to === start) {
          const edge = e1.rate + e2.rate;
          if (edge > minEdge) push([e1.pool, e2.pool], [start, a, start], edge);
          continue;
        }
        if (opts.maxHops < 3) continue;
        const b = e2.to;
        const back = bestBack.get(b);
        if (back === undefined || e1.rate + e2.rate + back <= minEdge) continue;
        for (const e3 of adj.get(b) ?? []) {
          if (e3.to !== start || e3.pool === e1.pool || e3.pool === e2.pool) continue;
          const edge = e1.rate + e2.rate + e3.rate;
          if (edge > minEdge) push([e1.pool, e2.pool, e3.pool], [start, a, b, start], edge);
        }
      }
    }
  }
  out.sort((x, y) => y.logEdge - x.logEdge);
  return opts.maxCycles ? out.slice(0, opts.maxCycles) : out;

  function push(ps: P[], tokens: string[], logEdge: number): void {
    if (opts.exclude?.(ps)) return;
    const key = cycleKey(ps, tokens);
    if (seen.has(key)) {
      if (opts.stats) opts.stats.rotations++;
      return;
    }
    seen.add(key);
    out.push({ pools: ps, tokens, logEdge });
  }
}

/** Short human label such as "WETH>USDC>AERO>WETH". */
export function routeLabel(route: Route, symbol: (a: string) => string): string {
  return route.tokens.map(symbol).join(">");
}
