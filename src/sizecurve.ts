/**
 * Size curves: how profit changes with trade size for a recorded opportunity.
 *
 * Every opportunity the scanner keeps can carry `sizeCurve`: up to 12
 * `[amountIn, profitUsd]` points. A curve whose peak is not at the recorded
 * `amountIn`, or that is still rising at its right edge, points at a sizing bug
 * (a wrong upper bound, a CL range cap, a token-decimals mix-up). A curve that
 * stops early means larger sizes were infeasible (CL tick range crossed).
 *
 * Two modes (SIZE_CURVES):
 *   - "probe" (default, also "true"): exact profit at 1/6 .. 12/6 of the chosen
 *     size along the same pools (12 evaluations, ~15-40 us per opportunity).
 *     Same for classic two-pool and multi-hop routes.
 *   - "optimizer": multi-hop routes are re-run through optimizeRoute with its
 *     onSample callback and the curve is 12 points spread over every size the
 *     optimiser evaluated (shows what the optimiser saw; ~0.3 ms+ per route).
 *     Classic routes are sized in closed form (quoteArb), so they still probe.
 *   - "false": off.
 *
 * Only opportunities that survive the scanner's filters get a curve, and it is
 * computed before verification on the same reserve snapshot.
 *
 * profitUsd for each point is scaled from the opportunity's own profitUsd
 * (profit and USD value are proportional for one token at one price), so no
 * extra price lookups are needed.
 *
 * Pure maths, no ethers import.
 */
import { poolAmountOut, type PoolLike } from "./math.js";
import { evaluateRoute, optimizeRoute, type RoutePool } from "./routes.js";

export type SizeCurve = Array<[amountIn: string, profitUsd: number]>;

export const SIZE_CURVE_POINTS = 12;

export type SizeCurveMode = "probe" | "optimizer" | false;

/** SIZE_CURVES: "probe" (default; "true" too), "optimizer", or "false". */
export function sizeCurveMode(env: Record<string, string | undefined> = process.env): SizeCurveMode {
  const v = (env.SIZE_CURVES ?? "probe").toLowerCase();
  if (v === "false" || v === "off" || v === "0") return false;
  return v === "optimizer" ? "optimizer" : "probe";
}

/** On unless SIZE_CURVES=false. */
export function sizeCurvesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return sizeCurveMode(env) !== false;
}

/**
 * Pick up to `n` samples evenly spread over the sampled amountIn range
 * (nearest sample to each of n evenly spaced targets, duplicates dropped),
 * always keeping the best-profit sample. Returned sorted by amountIn.
 */
export function spreadSamples(xs: bigint[], ps: bigint[], n = SIZE_CURVE_POINTS): Array<[bigint, bigint]> {
  const len = Math.min(xs.length, ps.length);
  if (len === 0 || n <= 0) return [];
  const idx = Array.from({ length: len }, (_, i) => i).sort((a, b) => (xs[a]! < xs[b]! ? -1 : xs[a]! > xs[b]! ? 1 : 0));
  // Drop duplicate sizes (the optimiser re-evaluates the same point).
  const uniq: number[] = [];
  for (const i of idx) if (!uniq.length || xs[uniq[uniq.length - 1]!] !== xs[i]) uniq.push(i);
  let best = uniq[0]!;
  for (const i of uniq) if (ps[i]! > ps[best]!) best = i;
  if (uniq.length <= n) return uniq.map((i) => [xs[i]!, ps[i]!]);

  const lo = xs[uniq[0]!]!;
  const hi = xs[uniq[uniq.length - 1]!]!;
  const picked = new Set<number>();
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = n === 1 ? lo : lo + ((hi - lo) * BigInt(k)) / BigInt(n - 1);
    // uniq is sorted, so walk forward to the nearest sample.
    while (j + 1 < uniq.length && absDiff(xs[uniq[j + 1]!]!, target) <= absDiff(xs[uniq[j]!]!, target)) j++;
    picked.add(uniq[j]!);
  }
  if (!picked.has(best)) {
    // Swap the best point in for the nearest interior pick (the ends show the range).
    if (picked.size >= n) {
      let drop = -1;
      for (const i of picked) {
        if (i === uniq[0] || i === uniq[uniq.length - 1]) continue;
        if (drop < 0 || absDiff(xs[i]!, xs[best]!) < absDiff(xs[drop]!, xs[best]!)) drop = i;
      }
      if (drop >= 0) picked.delete(drop);
    }
    picked.add(best);
  }
  return [...picked].sort((a, b) => (xs[a]! < xs[b]! ? -1 : xs[a]! > xs[b]! ? 1 : 0)).map((i) => [xs[i]!, ps[i]!]);
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/** Turn wei-level samples into the stored form, scaling USD from the opportunity's own profit. */
export function toCurve(samples: Array<[bigint, bigint]>, profit: bigint, profitUsd: number): SizeCurve | undefined {
  if (!samples.length || profit === 0n || !Number.isFinite(profitUsd)) return undefined;
  const scale = profitUsd / Number(profit);
  return samples.map(([x, p]) => [x.toString(), round(Number(p) * scale)]);
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Collects optimizeRoute samples for one route at a time. Usage in the scanner:
 *
 *   rec.begin();
 *   const q = optimizeRoute(route, undefined, rec.sample);
 *   if (q) rec.keep(q);
 *   ...
 *   opp.sizeCurve = rec.curve(q, profitUsd);
 *
 * Kept samples are reduced to SIZE_CURVE_POINTS immediately, so memory per
 * block is ~12 bigint pairs per positive route.
 */
export class SizeCurveRecorder {
  private xs: bigint[] = [];
  private ps: bigint[] = [];
  private kept = new WeakMap<object, Array<[bigint, bigint]>>();

  /** Bound so it can be passed straight to optimizeRoute. */
  readonly sample = (amountIn: bigint, profit: bigint): void => {
    this.xs.push(amountIn);
    this.ps.push(profit);
  };

  begin(): void {
    this.xs.length = 0;
    this.ps.length = 0;
  }

  /** Attach the samples gathered since begin() to this quote. */
  keep(quote: object): void {
    this.kept.set(quote, spreadSamples(this.xs, this.ps));
    this.begin();
  }

  curve(quote: object, profit: bigint, profitUsd: number): SizeCurve | undefined {
    const s = this.kept.get(quote);
    return s ? toCurve(s, profit, profitUsd) : undefined;
  }
}

/** Classic two-pool route: exact profit at 1/6 .. 12/6 of the chosen size. */
export function classicSizeCurve(buy: PoolLike, sell: PoolLike, tokenIn: string, tokenMid: string, amountIn: bigint, profit: bigint, profitUsd: number): SizeCurve | undefined {
  if (amountIn <= 0n) return undefined;
  const samples: Array<[bigint, bigint]> = [];
  for (let k = 1n; k <= BigInt(SIZE_CURVE_POINTS); k++) {
    const x = (amountIn * k) / 6n;
    if (x <= 0n) continue;
    const mid = poolAmountOut(buy, tokenIn, x);
    const out = mid > 0n ? poolAmountOut(sell, tokenMid, mid) : 0n;
    samples.push([x, out - x]);
  }
  return toCurve(samples, profit, profitUsd);
}

/** Any route (classic or multi-hop): exact profit at 1/6 .. 12/6 of the chosen size; infeasible sizes are left out. */
export function probeRouteCurve<P extends RoutePool>(pools: P[], tokens: string[], amountIn: bigint, profit: bigint, profitUsd: number): SizeCurve | undefined {
  if (amountIn <= 0n) return undefined;
  const samples: Array<[bigint, bigint]> = [];
  for (let k = 1n; k <= BigInt(SIZE_CURVE_POINTS); k++) {
    const x = (amountIn * k) / 6n;
    if (x <= 0n) continue;
    const q = evaluateRoute({ pools, tokens }, x);
    if (q) samples.push([x, q.profit]);
  }
  return toCurve(samples, profit, profitUsd);
}

/** What attachSizeCurve needs from an Opportunity (src/scanner.ts). */
export interface CurveTarget {
  route?: { pools: string[]; tokens: string[] } | undefined;
  buyPool: string;
  sellPool: string;
  tokenIn: string;
  tokenMid: string;
  amountIn: bigint;
  profit: bigint;
  profitUsd: number;
  sizeCurve?: SizeCurve;
}

const recorder = new SizeCurveRecorder();

/** Set o.sizeCurve from the pools' current state. Never throws (a curve is diagnostics only). */
export function attachSizeCurve<P extends RoutePool>(o: CurveTarget, pool: (address: string) => P | undefined, mode: SizeCurveMode = "probe"): void {
  if (!mode) return;
  try {
    let c: SizeCurve | undefined;
    if (o.route) {
      const pools = o.route.pools.map(pool);
      if (pools.some((p) => !p)) return;
      if (mode === "optimizer") {
        recorder.begin();
        const q = optimizeRoute({ pools: pools as P[], tokens: o.route.tokens }, undefined, recorder.sample);
        if (q) {
          recorder.keep(q);
          c = recorder.curve(q, o.profit, o.profitUsd);
        }
      } else c = probeRouteCurve(pools as P[], o.route.tokens, o.amountIn, o.profit, o.profitUsd);
    } else {
      const buy = pool(o.buyPool);
      const sell = pool(o.sellPool);
      if (!buy || !sell) return;
      c = classicSizeCurve(buy, sell, o.tokenIn, o.tokenMid, o.amountIn, o.profit, o.profitUsd);
    }
    if (c) o.sizeCurve = c;
  } catch {
    /* diagnostics only */
  }
}
