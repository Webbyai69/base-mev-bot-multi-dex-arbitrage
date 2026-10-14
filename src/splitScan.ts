/**
 * Split trades in the scanner and the paper engine (src/split.ts does the maths).
 *
 * PAPER ONLY. A split opportunity has no `route` and its `sim` can only ever
 * be "local", "quoter-ok" or "quoter-mismatch" (never "executor-ok"), so the
 * live path (executor.pickLiveSend / pickLiveOpportunity, which require
 * executor-ok) can never send one. There is no contract that executes splits
 * yet; docs/split-execution.md is the design.
 *
 * Splits are found after the scanner's per-block dedupe and are deduped only
 * among themselves, so they never displace an executable route that shares a
 * pool with them. They are not fed to the learning engine (its route and pool
 * statistics drive live decisions).
 *
 * No runtime import of ethers or config (the scanner passes in what it
 * needs), so this file is unit-tested without dependencies.
 */
import type { Pool } from "./pools.js";
import type { Opportunity } from "./scanner.js";
import { findSplitTrades, evaluatePlan, splitLabel, type SplitQuote } from "./split.js";

/** SPLIT_* settings (config.ts splitSettings()). */
export interface SplitSettings {
  /** SPLIT_TRADES: find and record split trades in paper mode. */
  enabled: boolean;
  /** SPLIT_ON_FLASHBLOCKS: also search on Flashblock (pre-confirmed) scans. */
  onFlashblocks: boolean;
  /** SPLIT_MAX_POOLS_PER_PAIR: deepest pools per pair considered. */
  maxPoolsPerPair: number;
  /** SPLIT_MAX_MS: CPU budget per scan; pairs not reached in time are skipped this block. */
  maxMs: number;
}

export const SPLIT_DEFAULTS: SplitSettings = { enabled: false, onFlashblocks: false, maxPoolsPerPair: 8, maxMs: 15 };

export interface SplitLegInfo {
  pool: string;
  dex: string;
  amountIn: bigint;
  amountOut: bigint;
}

/** Opportunity.split: the legs, in execution order (all buys, then the sells; the last sell takes the remaining balance). */
export interface SplitInfo {
  label: string;
  tokenMid: string;
  buys: SplitLegInfo[];
  sells: SplitLegInfo[];
  /** Mid token bought but not sold (always 0 unless every sell is range-capped). */
  dust: bigint;
  gasUnits: number;
  /** The best single two-pool route on the same pools, for comparison (net of its own gas). */
  bestSingle: { buyPool: string; sellPool: string; amountIn: bigint; profit: bigint; netUsd: number | null } | null;
  /** netUsd of the split minus netUsd of the best single route: what splitting adds. */
  gainUsd: number;
}

export interface SplitGasModel {
  gasRouteBase: number;
  gasHopV2: number;
  gasHopCl: number;
}

const DEFAULT_GAS: SplitGasModel = { gasRouteBase: 70_000, gasHopV2: 75_000, gasHopCl: 115_000 };

/** Gas units for a set of legs under the paper cost model (same constants as multi-hop routes). */
export function splitGasUnits(pools: Array<Pick<Pool, "cl">>, g: SplitGasModel = DEFAULT_GAS): number {
  return g.gasRouteBase + pools.reduce((s, p) => s + (p.cl ? g.gasHopCl : g.gasHopV2), 0);
}

/** The parts of the scanner this module needs (structural, so tests can pass a stub). */
export interface SplitScannerLike {
  registry: {
    pools: Map<string, Pool>;
    symbol(a: string): string;
    usdValue(token: string, amount: bigint, ethUsd: number): number | null;
    token(a: string): { decimals: number } | undefined;
  };
  routeOpts?: SplitGasModel;
  blockedTokens?: () => Set<string>;
}

export interface SplitScanInput {
  block: number;
  /** baseFee + priority fee, wei per gas. */
  gasPriceWei: bigint;
  l1FeeWei: bigint;
  ethUsd: number;
  minNetUsd: number;
  startTokens: string[];
  stage?: "block" | "flashblock";
  msIntoBlock?: number;
  only?: Set<string>;
}

function weiUsd(wei: bigint, ethUsd: number): number {
  return (Number(wei) / 1e18) * ethUsd;
}

/** Token units worth `usd`, priced like everything else (registry.usdValue). Null when unpriced. */
function unitsForUsd(s: SplitScannerLike, token: string, usd: number, ethUsd: number): bigint | null {
  const dec = s.registry.token(token)?.decimals ?? 18;
  const one = 10n ** BigInt(dec);
  const perUnit = s.registry.usdValue(token, one, ethUsd);
  if (perUnit === null || !(perUnit > 0) || !(usd >= 0)) return null;
  return BigInt(Math.floor((usd / perUnit) * 10 ** Math.min(dec, 15))) * 10n ** BigInt(Math.max(0, dec - 15));
}

export function splitKey(o: { tokenIn: string; split: SplitInfo }): string {
  return `split:${o.split.buys.map((l) => l.pool).join("+")}>${o.split.sells.map((l) => l.pool).join("+")}-${o.tokenIn}`;
}

/**
 * Split opportunities at the current pool snapshot, priced in USD, net of
 * gas, kept only when net >= minNetUsd and better than the best single route
 * on the same pools (net of its own gas). Deduped among themselves (one per
 * pool set). sim = "local" until verifySplits runs.
 */
export function findSplitOpportunities(s: SplitScannerLike, cfg: SplitSettings, inp: SplitScanInput): Opportunity[] {
  if (!cfg.enabled) return [];
  if (inp.stage === "flashblock" && !cfg.onFlashblocks) return [];
  const gasModel = s.routeOpts ?? DEFAULT_GAS;
  const blocked = s.blockedTokens?.() ?? new Set<string>();
  const legUsd = weiUsd(BigInt(Math.min(gasModel.gasHopV2, gasModel.gasHopCl)) * inp.gasPriceWei, inp.ethUsd);
  const legCostCache = new Map<string, bigint>();
  const legCost = (token: string): bigint => {
    let c = legCostCache.get(token);
    if (c === undefined) legCostCache.set(token, (c = unitsForUsd(s, token, legUsd, inp.ethUsd) ?? 0n));
    return c;
  };
  const pools = inp.only ? [...inp.only].map((a) => s.registry.pools.get(a)).filter((p): p is Pool => !!p) : s.registry.pools.values();
  const quotes = findSplitTrades<Pool>(pools, inp.startTokens, {
    legCost,
    maxPoolsPerPair: cfg.maxPoolsPerPair,
    deadline: Date.now() + cfg.maxMs,
    exclude: (p) => blocked.has(p.token0) || blocked.has(p.token1),
  });
  const gasUsdFor = (ps: Pool[]): number => weiUsd(BigInt(splitGasUnits(ps, gasModel)) * inp.gasPriceWei + inp.l1FeeWei, inp.ethUsd);
  const out: Opportunity[] = [];
  const usedPools = new Set<string>();
  for (const q of quotes) {
    const o = toOpportunity(s, q, inp, gasUsdFor);
    if (!o) continue;
    const ps = [...o.split!.buys, ...o.split!.sells].map((l) => l.pool);
    if (ps.some((p) => usedPools.has(p))) continue;
    for (const p of ps) usedPools.add(p);
    out.push(o);
  }
  return out;
}

function toOpportunity(s: SplitScannerLike, q: SplitQuote<Pool>, inp: SplitScanInput, gasUsdFor: (ps: Pool[]) => number): Opportunity | null {
  const profitUsd = s.registry.usdValue(q.tokenIn, q.profit, inp.ethUsd);
  if (profitUsd === null) return null;
  const legPools = [...q.buys, ...q.sells].map((l) => l.pool);
  const gasUsd = gasUsdFor(legPools);
  const netUsd = profitUsd - gasUsd;
  if (!(netUsd >= inp.minNetUsd)) return null;
  let single: SplitInfo["bestSingle"] = null;
  let singleNet = 0;
  if (q.bestSingle) {
    const u = s.registry.usdValue(q.tokenIn, q.bestSingle.profit, inp.ethUsd);
    const n = u === null ? null : u - gasUsdFor([q.bestSingle.buy, q.bestSingle.sell]);
    single = { buyPool: q.bestSingle.buy.address, sellPool: q.bestSingle.sell.address, amountIn: q.bestSingle.amountIn, profit: q.bestSingle.profit, netUsd: n };
    if (n !== null) singleNet = Math.max(0, n);
  }
  // Must beat the single route after both pay their own gas (the optimiser only charged extra legs approximately).
  if (!(netUsd > singleNet)) return null;
  const label = splitLabel(q, (a) => s.registry.symbol(a));
  const leg = (l: SplitQuote<Pool>["buys"][number]): SplitLegInfo => ({ pool: l.pool.address, dex: l.pool.dex, amountIn: l.amountIn, amountOut: l.amountOut });
  const first = q.buys[0]!.pool;
  const last = q.sells[q.sells.length - 1]!.pool;
  return {
    id: `${inp.block}-${inp.stage === "flashblock" ? "fb-" : ""}sp-${legPools.map((p) => p.address.slice(2, 8)).join("")}-${q.tokenIn.slice(2, 8)}`,
    block: inp.block,
    foundAt: new Date().toISOString(),
    pair: legPools.map((p) => p.address).sort().join("-"),
    pairSymbols: label,
    buyPool: first.address,
    buyDex: first.dex,
    sellPool: last.address,
    sellDex: last.dex,
    tokenIn: q.tokenIn,
    tokenInSymbol: s.registry.symbol(q.tokenIn),
    tokenMid: q.tokenMid,
    amountIn: q.amountIn,
    amountMid: q.amountMid,
    amountOut: q.amountOut,
    profit: q.profit,
    profitUsd,
    gasUsd,
    netUsd,
    sim: "local",
    hops: legPools.length,
    stage: inp.stage ?? "block",
    ...(inp.msIntoBlock !== undefined ? { msIntoBlock: inp.msIntoBlock } : {}),
    split: {
      label,
      tokenMid: q.tokenMid,
      buys: q.buys.map(leg),
      sells: q.sells.map(leg),
      dust: q.dust,
      gasUnits: splitGasUnits(legPools, s.routeOpts ?? DEFAULT_GAS),
      bestSingle: single,
      gainUsd: netUsd - singleNet,
    },
  };
}

export interface QuoteResult {
  success: boolean;
  returnData: string;
}

/** What verifySplits needs from the scanner: the per-hop quoter encoder/decoder and a multicall. */
export interface SplitVerifyDeps {
  pool(address: string): Pool | undefined;
  quoteCall(pool: Pool, tokenIn: string, tokenOut: string, amountIn: bigint): { target: string; callData: string };
  decode(pool: Pool, r: QuoteResult): bigint | null;
  multicall(calls: Array<{ target: string; callData: string }>, tag: number | "pending"): Promise<QuoteResult[]>;
  warn?(msg: string): void;
}

/**
 * Verify every leg against its DEX's own quoter in one multicall (scanner.hopQuoteCall).
 * Each leg is on a different pool, so independent quotes at the same block are exact.
 * Sets sim to quoter-ok / quoter-mismatch; never to anything executor-*.
 */
export async function verifySplits(opps: Opportunity[], tag: number | "pending", deps: SplitVerifyDeps): Promise<void> {
  const calls: Array<{ target: string; callData: string }> = [];
  const index: Array<{ o: Opportunity; pool: Pool; want: bigint; at: number; what: string }> = [];
  for (const o of opps) {
    const sp = o.split;
    if (!sp) continue;
    const legs = [...sp.buys.map((l) => ({ l, tin: o.tokenIn, tout: sp.tokenMid, side: "buy" })), ...sp.sells.map((l) => ({ l, tin: sp.tokenMid, tout: o.tokenIn, side: "sell" }))];
    for (const { l, tin, tout, side } of legs) {
      const pool = deps.pool(l.pool);
      if (!pool) {
        o.sim = "quoter-mismatch";
        o.simDetail = `${side} pool ${l.pool} no longer watched`;
        continue;
      }
      index.push({ o, pool, want: l.amountOut, at: calls.length, what: `${side} ${pool.dex} ${l.pool.slice(0, 10)}` });
      calls.push(deps.quoteCall(pool, tin, tout, l.amountIn));
    }
  }
  if (!calls.length) return;
  let res: QuoteResult[];
  try {
    res = await deps.multicall(calls, tag);
  } catch (err) {
    deps.warn?.(`split quoter verification failed: ${(err as Error).message.slice(0, 120)}`);
    return;
  }
  const bad = new Map<Opportunity, string>();
  for (const { o, pool, want, at, what } of index) {
    if (bad.has(o)) continue;
    const r = res[at];
    const got = r ? deps.decode(pool, r) : null;
    if (got === null) bad.set(o, `${what}: quoter call failed`);
    else if (got !== want) bad.set(o, `${what}: quoter ${got} vs local ${want}`);
  }
  for (const o of opps) {
    if (!o.split || o.sim === "quoter-mismatch") continue;
    const why = bad.get(o);
    o.sim = why ? "quoter-mismatch" : "quoter-ok";
    if (why) o.simDetail = why;
  }
}

/** Paper re-pricing: the same legs at the same buy sizes on the current pools (last sell takes what was bought). */
export function repriceSplit(o: Pick<Opportunity, "tokenIn" | "split">, pool: (a: string) => Pool | undefined): bigint | null {
  const sp = o.split;
  if (!sp) return null;
  const get = (l: SplitLegInfo) => pool(l.pool);
  const buys = sp.buys.map((l) => ({ pool: get(l), amountIn: l.amountIn }));
  const sells = sp.sells.map((l) => ({ pool: get(l), amountIn: l.amountIn }));
  if ([...buys, ...sells].some((l) => !l.pool)) return null;
  const q = evaluatePlan(o.tokenIn, sp.tokenMid, { buys: buys as Array<{ pool: Pool; amountIn: bigint }>, sells: sells as Array<{ pool: Pool; amountIn: bigint }> });
  return q ? q.profit : null;
}

/** Every pool a split touches. */
export function splitPools(sp: SplitInfo): string[] {
  return [...sp.buys, ...sp.sells].map((l) => l.pool);
}
