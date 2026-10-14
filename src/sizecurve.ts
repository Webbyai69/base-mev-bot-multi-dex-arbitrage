/**
 * Size curves: how profit changes with trade size for a recorded opportunity.
 *
 * Every opportunity the scanner records can carry `sizeCurve`, up to 12
 * `[amountIn, profitUsd]` points spread evenly over the sizes that were
 * looked at. A curve whose peak is not at the recorded `amountIn`, or that is
 * still rising at its right edge, points at a sizing bug (a wrong upper bound,
 * a CL range cap, a token-decimals mix-up).
 *
 *   - Multi-hop / CL routes: the points come from optimizeRoute itself (its
 *     onSample callback sees every feasible size it evaluated), so the curve
 *     shows what the optimiser actually saw.
 *   - Classic two-pool V2 routes are sized in closed form (quoteArb), so there
 *     is nothing to observe; we probe the same two pools at 1/6 .. 12/6 of the
 *     chosen size instead (12 exact evaluations, cheap).
 *
 * profitUsd for each point is scaled from the opportunity's own profitUsd
 * (profit and USD value are proportional for one token at one price), so no
 * extra price lookups are needed.
 *
 * Pure maths, no ethers import. SIZE_CURVES=false turns it off.
 */
import { poolAmountOut, type PoolLike } from "./math.js";

export type SizeCurve = Array<[amountIn: string, profitUsd: number]>;

export const SIZE_CURVE_POINTS = 12;

/** On unless SIZE_CURVES=false. */
export function sizeCurvesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SIZE_CURVES ?? "true").toLowerCase() !== "false";
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
  const picked = new Set<number>([best]);
  let j = 0;
  for (let k = 0; k < n && picked.size < n; k++) {
    const target = n === 1 ? lo : lo + ((hi - lo) * BigInt(k)) / BigInt(n - 1);
    // uniq is sorted, so walk forward to the nearest sample.
    while (j + 1 < uniq.length && absDiff(xs[uniq[j + 1]!]!, target) <= absDiff(xs[uniq[j]!]!, target)) j++;
    picked.add(uniq[j]!);
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
