/**
 * Per-block opportunity search: for every token pair that lives on two or
 * more watched pools, quote both directions and both pool orderings, price the
 * profit in USD, subtract the estimated gas, and rank.
 */
import type { Learner } from "./learn.js";
import { AbiCoder } from "ethers";
import { DEXES, TOKENS, USDC, WETH, V4, NATIVE } from "./config.js";
import { blocksFor } from "./blocktime.js";
import { aeroPoolIface, univ2RouterIface, executorIface, routeExecutorIface, univ3QuoterIface, slipstreamQuoterIface, v4QuoterIface } from "./abi.js";
import { quoteArb, type ArbQuote } from "./math.js";
import { findCycles, optimizeRoute, routeLabel, type RouteQuote } from "./routes.js";
import { SIM_EXECUTOR_RUNTIME } from "./simBytecode.js";
import { ROUTE_EXECUTOR_RUNTIME } from "./simBytecodeRoute.js";
import { pairKey, poolStateSig, type Pool, type PoolRegistry } from "./pools.js";
import type { Chain, Call } from "./rpc.js";
import type { GasQuote } from "./gas.js";
import { weiToUsd } from "./gas.js";
import { log } from "./log.js";

const abi = AbiCoder.defaultAbiCoder();

export interface Opportunity {
  id: string;
  block: number;
  foundAt: string;
  pair: string;
  pairSymbols: string;
  buyPool: string;
  buyDex: string;
  sellPool: string;
  sellDex: string;
  tokenIn: string;
  tokenInSymbol: string;
  tokenMid: string;
  amountIn: bigint;
  amountMid: bigint;
  amountOut: bigint;
  profit: bigint;
  profitUsd: number;
  gasUsd: number;
  netUsd: number;
  /** On-chain verification of our maths at the same block. */
  sim: "local" | "quoter-ok" | "quoter-mismatch" | "executor-ok" | "executor-revert";
  simDetail?: string;
  /** Multi-hop / concentrated-liquidity routes (RouteExecutor). Absent for classic two-pool V2 routes. */
  route?: RouteInfo;
  /** Number of swaps in the route (2 for classic routes). */
  hops: number;
  /** "block": found on a confirmed block; "flashblock": found on pre-confirmed state mid-block. */
  stage?: "block" | "flashblock";
  /** For flashblock finds: ms since the last confirmed block was seen. */
  msIntoBlock?: number;
}

export interface RouteInfo {
  tokens: string[];
  pools: string[];
  dexes: string[];
  /** amounts[0] = input, amounts[i+1] = output of hop i. */
  amounts: bigint[];
  label: string;
  /** (pool, kind, feePpm) as RouteExecutor expects them. */
  executorHops: Array<{ pool: string; kind: number; feePpm: number }>;
}

/** Key identifying a route (same pools, same direction, same start token). */
export function routeKey(o: { route?: RouteInfo; buyPool: string; sellPool: string; tokenIn: string }): string {
  return o.route ? `${o.route.pools.join(">")}-${o.tokenIn}` : `${o.buyPool}-${o.sellPool}-${o.tokenIn}`;
}

/** Every pool an opportunity touches. */
export function poolsOf(o: { route?: RouteInfo; buyPool: string; sellPool: string }): string[] {
  return o.route ? o.route.pools : [o.buyPool, o.sellPool];
}

export interface RouteOptions {
  multiHop: boolean;
  maxHops: 2 | 3;
  maxCycles: number;
  gasRouteBase: number;
  gasHopV2: number;
  gasHopCl: number;
  routeExecutorAddress?: string;
  flashSource: "morpho" | "balancer" | "capital";
}

/** RouteExecutor hop kinds (contracts/RouteExecutor.sol). */
export function hopKind(p: Pool): number {
  // Uniswap V4 (RouteExecutor kinds 4/5): 5 when the WETH side is native ETH (currency 0x0), else 4.
  if (p.v4) return p.v4.currency0 === NATIVE || p.v4.currency1 === NATIVE ? 5 : 4;
  if (p.cl) return 2;
  if (p.kind === "aerodrome") return 1;
  return p.feeModel === "bps" ? 3 : 0;
}

export function flashSourceId(s: RouteOptions["flashSource"]): number {
  return s === "capital" ? 0 : s === "morpho" ? 1 : 2;
}

/** Address that has no code on Base; the simulation bytecode is injected here via eth_call state override. */
export const SIM_OVERRIDE_ADDRESS = "0x00000000000000000000000000000000a4b17e51";
/** Same idea for the multi-hop RouteExecutor. */
export const SIM_ROUTE_OVERRIDE_ADDRESS = "0x00000000000000000000000000000000a4b17e52";

/**
 * Pool kinds the deployed RouteExecutor cannot trade yet (no swap callback for them). Their pools are
 * still watched, priced and scanned — so cross-venue spreads surface in paper, on the dashboard and in
 * the value-score — but any route through them is verified by the DEX's own quoter rather than the
 * executor simulation, so it is a real paper find (quoter-ok) and never reaches a live send (which
 * requires executor-ok). Remove a kind here once the RouteExecutor is rebuilt with its callback.
 */
const QUOTE_ONLY_KINDS = new Set<string>(["pancakev3", "univ4"]);

const routeKeyOf = routeKey;

/** Tokens a classic two-pool route prefers to start (and take its profit) in, best first. */
const START_PREFERENCE = [WETH, USDC, ...Object.values(TOKENS).map((t) => t.address.toLowerCase())];

/** The token a classic route between two pools starts in: one rotation per cycle, preferring base tokens. */
export function preferredStart(token0: string, token1: string): string {
  const r0 = START_PREFERENCE.indexOf(token0);
  const r1 = START_PREFERENCE.indexOf(token1);
  if (r0 < 0 && r1 < 0) return token0;
  if (r0 < 0) return token1;
  if (r1 < 0) return token0;
  return r0 <= r1 ? token0 : token1;
}

export interface ScanOptions {
  blockTag?: number | "pending";
  /** Restrict the search to these pools (and nothing else). */
  only?: Set<string>;
  stage?: "block" | "flashblock";
  msIntoBlock?: number;
  /**
   * Pools whose state changed since the last scan. Only routes through at least one of them are
   * re-scored; a route whose pools are all unchanged has the same answer as last time. When absent,
   * the scanner works it out itself by comparing every pool's state with what it saw last time.
   */
  changed?: Set<string>;
  /** Re-score every route regardless of what changed (periodic, and the first scan). */
  full?: boolean;
  /** Pre-confirmed copies of pools (Flashblocks), used instead of the registry's confirmed state. */
  overlay?: Map<string, Pool>;
  /** Pools to leave out entirely this scan (their pending state is unknown). */
  exclude?: Set<string>;
}

/** Where one scan's time went, for the per-block timing on the dashboard. */
export interface ScanTiming {
  /** Pool-state comparison, cycle search and size optimisation (CPU). */
  findMs: number;
  /** On-chain verification of the survivors (RPC). */
  verifyMs: number;
  /** Routes re-scored, and routes skipped because none of their pools changed. */
  scored: number;
  unchanged: number;
  /** Positive-spread routes after swap fees (the funnel's "route checks"). */
  candidates: number;
  changedPools: number;
  full: boolean;
}

export class Scanner {
  /**
   * How opportunities are verified on-chain:
   *   executor  a deployed ArbExecutor's simulate()      (exact)
   *   override  the same bytecode injected via eth_call state override — no
   *             deployment needed; used whenever no executor is configured
   *             and the RPC supports state overrides (Alchemy, QuickNode, geth)
   *   quoter    each DEX's own quoter (does not see fee-on-transfer tokens)
   */
  simMode: "executor" | "override" | "quoter";
  /** Routes whose simulation reverted, suppressed until the given block. */
  private failed = new Map<string, { count: number; until: number }>();
  /** The learning engine (src/learn.ts): skips what keeps failing, and learns from every test run. */
  learner?: Learner;
  /** Tokens you blocked on the dashboard (Tuning). */
  blockedTokens?: () => Set<string>;
  /** The latest learned skips, for the dashboard ("why it skipped …"). */
  readonly lastLearnedSkips: Array<{ label: string; why: string; at: string }> = [];
  /** Blocks a reverting route stays muted (~20 minutes). Derived from block time so it survives Denim's 200ms blocks. */
  failureMuteBlocks = blocksFor(20 * 60_000);
  /** After this many revert failures the token pair's pools are dropped from the watch list. */
  failuresBeforeDrop = 3;
  /** Re-score every route every N scans of confirmed blocks, whatever changed (FULL_RESCAN_BLOCKS). */
  fullRescanBlocks = 30;
  /** A find worth more than this (USD) is a pricing error, not an opportunity (SANITY_MAX_PROFIT_USD). */
  sanityMaxProfitUsd = Infinity;

  /** Routes found in the last scan before the profit floor (used to pick "hot" pools for Flashblocks). */
  lastCandidatePools = new Set<string>();
  /** Timing and work of the last scan. */
  lastTiming: ScanTiming = { findMs: 0, verifyMs: 0, scored: 0, unchanged: 0, candidates: 0, changedPools: 0, full: true };
  /** Route checks per venue since start (a route counts once for each DEX it touches). */
  readonly venues: Record<string, number> = {};

  /** Each pool's state at the last scan, to tell which pools changed. */
  private sigs = new Map<string, string>();
  private lastFullScan = -Infinity;
  /**
   * Routes that cleared the profit floor and whose pools haven't changed since: still open even
   * though they aren't re-scored (or re-reported) every block. The paper engine reads this so a
   * spread that sits open stays one trade.
   */
  private open = new Map<string, string[]>();

  constructor(
    readonly chain: Chain,
    readonly registry: PoolRegistry,
    readonly executorAddress?: string,
    readonly useOverride = true,
    readonly routeOpts?: RouteOptions,
  ) {
    this.simMode = executorAddress ? "executor" : useOverride ? "override" : "quoter";
  }

  /** How multi-hop routes are verified: deployed RouteExecutor, injected bytecode, or per-hop quoters. */
  get routeSimMode(): "executor" | "override" | "quoter" {
    if (this.routeOpts?.routeExecutorAddress) return "executor";
    if (this.useOverride && ROUTE_EXECUTOR_RUNTIME && this.simMode !== "quoter") return "override";
    return "quoter";
  }

  /** Keys of routes still open (cleared the floor, pools unchanged since). */
  openRouteKeys(): Set<string> {
    return new Set(this.open.keys());
  }

  /**
   * Multi-hop and concentrated-liquidity routes. Pure V2 two-pool routes are
   * left to findRaw() (they run through the original ArbExecutor).
   *
   * With `changed`, only cycles through a changed pool are sized (the expensive part); MAX_CYCLES
   * then caps the cycles actually re-scored, so a stale high-edge cycle can't crowd out fresh ones.
   */
  findRoutes(pools?: Iterable<Pool>, changed?: Set<string>, stats?: { cycles: number; unchanged: number; rotations: number }): RouteQuote<Pool>[] {
    const o = this.routeOpts;
    if (!o || !o.multiHop) return [];
    const st = { rotations: 0 };
    let cycles = findCycles<Pool>(pools ?? this.registry.pools.values(), {
      startTokens: [WETH, USDC],
      maxHops: o.maxHops,
      exclude: (ps) => ps.length === 2 && ps.every((p) => !(p as Pool).cl),
      stats: st,
    });
    const total = cycles.length;
    if (changed) cycles = cycles.filter((c) => c.pools.some((p) => changed.has(p.address)));
    if (stats) {
      stats.cycles += total;
      stats.unchanged += total - cycles.length;
      stats.rotations += st.rotations;
    }
    if (o.maxCycles && cycles.length > o.maxCycles) cycles = cycles.slice(0, o.maxCycles);
    const out: RouteQuote<Pool>[] = [];
    for (const c of cycles) {
      const q = optimizeRoute(c);
      if (q) out.push(q);
    }
    return out;
  }

  /** Gas units for a route under the paper cost model. */
  routeGasUnits(pools: Pool[]): number {
    const o = this.routeOpts!;
    return o.gasRouteBase + pools.reduce((sum, p) => sum + (p.cl ? o.gasHopCl : o.gasHopV2), 0);
  }

  /**
   * All positive-profit classic routes at the current reserve snapshot, before gas. Each cycle is
   * quoted once, starting in its preferred token (WETH first): "buy on A with WETH, sell on B" and
   * "buy on B with X, sell on A" are the same trade read from a different token.
   */
  findRaw(maxAmountInWeth?: bigint, only?: Set<string>, changed?: Set<string>, pools?: Iterable<Pool>, stats?: { cycles: number; unchanged: number }): ArbQuote[] {
    const quotes: ArbQuote[] = [];
    const groups = pools ? groupByPair(pools) : this.registry.groups();
    for (const [, all] of groups) {
      const ps = all.filter((p) => !p.cl && (!only || only.has(p.address)));
      if (ps.length < 2) continue;
      for (let i = 0; i < ps.length; i++) {
        for (let j = 0; j < ps.length; j++) {
          if (i === j) continue;
          const buy = ps[i]!;
          const sell = ps[j]!;
          if (buy.reserve0 === 0n || sell.reserve0 === 0n) continue;
          if (stats) stats.cycles++;
          if (changed && !changed.has(buy.address) && !changed.has(sell.address)) {
            if (stats) stats.unchanged++;
            continue;
          }
          const tokenIn = preferredStart(buy.token0, buy.token1);
          const cap = tokenIn === WETH ? maxAmountInWeth : undefined;
          const q = quoteArb(buy, sell, tokenIn, cap);
          if (q) quotes.push(q);
        }
      }
    }
    return quotes;
  }

  /** Which pools changed since the last scan (by state), remembering the current state for next time. */
  private changedPools(pools: Iterable<Pool>): Set<string> {
    const changed = new Set<string>();
    const seen = new Set<string>();
    for (const p of pools) {
      seen.add(p.address);
      const sig = poolStateSig(p);
      if (this.sigs.get(p.address) !== sig) {
        changed.add(p.address);
        this.sigs.set(p.address, sig);
      }
    }
    for (const a of this.sigs.keys()) if (!seen.has(a)) this.sigs.delete(a);
    return changed;
  }

  /** Price, gas-adjust and rank; returns opportunities above `minNetUsd`. */
  async scan(block: number, gas: GasQuote, ethUsd: number, minNetUsd: number, opts: ScanOptions = {}): Promise<Opportunity[]> {
    const t0 = Date.now();
    const F = this.funnel;
    // The pools this scan sees: the registry's, with pre-confirmed copies swapped in and unknowns left out.
    let pools: Pool[] | undefined;
    if (opts.overlay || opts.exclude || opts.only) {
      pools = [];
      for (const p of this.registry.pools.values()) {
        if (opts.exclude?.has(p.address) || (opts.only && !opts.only.has(p.address))) continue;
        pools.push(opts.overlay?.get(p.address) ?? p);
      }
    }
    // What to re-score: everything on a full scan, else only routes through a changed pool.
    let changed: Set<string> | undefined;
    let full = !!opts.full;
    if (!full && !opts.changed) {
      const ch = this.changedPools(pools ?? this.registry.pools.values());
      if (block - this.lastFullScan >= this.fullRescanBlocks) full = true;
      else changed = ch;
    } else if (!full) {
      changed = opts.changed;
    }
    if (full) {
      this.lastFullScan = block;
      if (!opts.changed && !opts.overlay) this.changedPools(pools ?? this.registry.pools.values());
    }
    const stats = { cycles: 0, unchanged: 0, rotations: 0 };
    const raw = this.findRaw(undefined, undefined, changed, pools, stats);
    const routes = this.findRoutes(pools, changed, stats);
    const gasUsd = weiToUsd(gas.totalWei, ethUsd);
    const gasPrice = gas.baseFeeWei + gas.priorityFeeWei;
    const opps: Opportunity[] = [];
    F.scans++;
    F.candidates += raw.length + routes.length;
    F.unchanged += stats.unchanged;
    F.rotations += stats.rotations;
    const priceOut = (netUsd: number): boolean => {
      if (netUsd >= minNetUsd) return false;
      if (netUsd < 0) F.gasAteIt++;
      else F.belowMin++;
      return true;
    };
    const tooGood = (profitUsd: number): boolean => {
      if (profitUsd <= this.sanityMaxProfitUsd) return false;
      F.outlier++;
      return true;
    };
    const countVenues = (dexes: string[]) => {
      for (const d of new Set(dexes)) this.venues[d] = (this.venues[d] ?? 0) + 1;
    };
    this.lastCandidatePools = new Set([...raw.flatMap((q) => [q.buyPool.address, q.sellPool.address]), ...routes.flatMap((r) => r.pools.map((p) => p.address))]);
    for (const r of routes) {
      countVenues(r.pools.map((p) => p.dex));
      const tokenIn = r.tokens[0]!;
      const profitUsd = this.registry.usdValue(tokenIn, r.profit, ethUsd);
      if (profitUsd === null) {
        F.unpriced++;
        continue;
      }
      if (tooGood(profitUsd)) continue;
      const routeGasUsd = weiToUsd(BigInt(this.routeGasUnits(r.pools)) * gasPrice + gas.l1FeeWei, ethUsd);
      const netUsd = profitUsd - routeGasUsd;
      if (priceOut(netUsd)) continue;
      const first = r.pools[0]!;
      const last = r.pools[r.pools.length - 1]!;
      const label = routeLabel(r, (a) => this.registry.symbol(a));
      opps.push({
        id: `${block}-${opts.stage === "flashblock" ? "fb-" : ""}${r.pools.map((p) => p.address.slice(2, 8)).join("")}-${tokenIn.slice(2, 8)}`,
        block,
        foundAt: new Date().toISOString(),
        pair: r.pools.map((p) => p.address).sort().join("-"),
        pairSymbols: label,
        buyPool: first.address,
        buyDex: first.dex,
        sellPool: last.address,
        sellDex: last.dex,
        tokenIn,
        tokenInSymbol: this.registry.symbol(tokenIn),
        tokenMid: r.tokens[1]!,
        amountIn: r.amounts[0]!,
        amountMid: r.amounts[1]!,
        amountOut: r.amounts[r.amounts.length - 1]!,
        profit: r.profit,
        profitUsd,
        gasUsd: routeGasUsd,
        netUsd,
        sim: "local",
        hops: r.pools.length,
        stage: opts.stage ?? "block",
        ...(opts.msIntoBlock !== undefined ? { msIntoBlock: opts.msIntoBlock } : {}),
        route: {
          tokens: r.tokens,
          pools: r.pools.map((p) => p.address),
          dexes: r.pools.map((p) => p.dex),
          amounts: r.amounts,
          label,
          // A V4 pool's address is its poolId (not a contract), so the on-chain hop carries the PoolManager;
          // the executor derives the PoolKey from the hop's tokens + fee. feePpm is the V4 fee tier.
          executorHops: r.pools.map((p) => ({ pool: p.v4 ? V4.poolManager : p.address, kind: hopKind(p), feePpm: Math.max(0, p.feePpm) })),
        },
      });
    }
    for (const q of raw) {
      const buy = q.buyPool as Pool;
      const sell = q.sellPool as Pool;
      countVenues([buy.dex, sell.dex]);
      const profitUsd = this.registry.usdValue(q.tokenIn, q.profit, ethUsd);
      if (profitUsd === null) {
        F.unpriced++; // cannot price -> cannot judge; skip
        continue;
      }
      if (tooGood(profitUsd)) continue;
      const netUsd = profitUsd - gasUsd;
      if (priceOut(netUsd)) continue;
      const pair = [buy.token0, buy.token1].sort().join("-");
      opps.push({
        id: `${block}-${opts.stage === "flashblock" ? "fb-" : ""}${buy.address.slice(2, 10)}-${sell.address.slice(2, 10)}-${q.tokenIn.slice(2, 8)}`,
        block,
        foundAt: new Date().toISOString(),
        pair,
        pairSymbols: `${this.registry.symbol(buy.token0)}/${this.registry.symbol(buy.token1)}`,
        buyPool: buy.address,
        buyDex: buy.dex,
        sellPool: sell.address,
        sellDex: sell.dex,
        tokenIn: q.tokenIn,
        tokenInSymbol: this.registry.symbol(q.tokenIn),
        tokenMid: q.tokenMid,
        amountIn: q.amountIn,
        amountMid: q.amountMid,
        amountOut: q.amountOut,
        profit: q.profit,
        profitUsd,
        gasUsd,
        netUsd,
        sim: "local",
        hops: 2,
        stage: opts.stage ?? "block",
        ...(opts.msIntoBlock !== undefined ? { msIntoBlock: opts.msIntoBlock } : {}),
      });
    }
    // Still-open routes: the confirmed-block scan keeps the set, so an unchanged spread isn't
    // re-reported (or re-simulated) every block yet still counts as one open trade.
    if ((opts.stage ?? "block") === "block" && !opts.overlay) {
      const passing = new Set(opps.map(routeKeyOf));
      for (const [k, ps] of this.open) if (!passing.has(k) && (full || ps.some((p) => changed!.has(p)))) this.open.delete(k);
      for (const o of opps) this.open.set(routeKeyOf(o), poolsOf(o));
    }
    opps.sort((a, b) => b.netUsd - a.netUsd);
    // Routes that share a pool compete for the same reserves, so only one of them can be
    // taken: keep the most profitable and drop any later route touching a pool already used.
    // Classic routes also keep at most one per token pair, as before.
    // Routes whose on-chain simulation reverted recently are skipped entirely.
    const seen = new Set<string>();
    const usedPools = new Set<string>();
    const now = Date.now();
    const blocked = this.blockedTokens?.() ?? new Set<string>();
    const unique = opps.filter((o) => {
      const f = this.failed.get(routeKeyOf(o));
      if (f && f.until > block) {
        F.muted++;
        return false;
      }
      if (this.learner) {
        const why = this.learner.skipReason(o, now, blocked);
        if (why) {
          F.learnedSkip++;
          this.lastLearnedSkips.unshift({ label: o.pairSymbols, why, at: new Date(now).toISOString() });
          if (this.lastLearnedSkips.length > 10) this.lastLearnedSkips.length = 10;
          return false;
        }
      }
      const ps = poolsOf(o);
      if ((!o.route && seen.has(o.pair)) || ps.some((p) => usedPools.has(p))) {
        F.overlapping++;
        return false;
      }
      if (!o.route) seen.add(o.pair);
      for (const p of ps) usedPools.add(p);
      return true;
    });
    const t1 = Date.now();
    const tag = opts.blockTag ?? block;
    const classic = unique.filter((o) => !o.route);
    const multi = unique.filter((o) => o.route);
    await Promise.all([classic.length ? this.verify(classic, tag) : undefined, multi.length ? this.verifyRoutes(multi, tag) : undefined]);
    for (const o of unique) {
      if (this.learner) {
        this.learner.onFound(o, now);
        this.learner.onSim(o, now);
      }
      if (o.sim === "executor-revert") this.recordFailure(o, block);
      if (o.sim === "executor-ok" || o.sim === "quoter-ok") F.verified++;
      else if (o.sim === "executor-revert") F.reverted++;
      else if (o.sim === "quoter-mismatch") F.quoteMismatch++;
      else F.unverified++;
    }
    this.lastTiming = { findMs: t1 - t0, verifyMs: Date.now() - t1, scored: stats.cycles - stats.unchanged, unchanged: stats.unchanged, candidates: raw.length + routes.length, changedPools: changed?.size ?? (pools ?? [...this.registry.pools.values()]).length, full };
    return unique;
  }

  /**
   * Where candidates drop out, counted since start (dashboard "Why opportunities
   * don't trade", daily digest). A candidate is one positive-spread route in one
   * block, so a spread that stays open for 30 blocks counts 30 times.
   */
  readonly funnel = {
    scans: 0,
    /** Positive spread after swap fees, before gas (NET_PROFIT not yet known). */
    candidates: 0,
    /** Routes not re-scored because none of their pools changed since the last scan (repeated work avoided). */
    unchanged: 0,
    /** The same cycle reached again from another start token (WETH>…>USDC>WETH vs USDC>…>WETH>USDC); scored once. */
    rotations: 0,
    /** Profit token has no USD price. */
    unpriced: 0,
    /** Valued above SANITY_MAX_PROFIT_USD: a pricing error, not an opportunity. */
    outlier: 0,
    /** Gas cost more than the spread (net < 0). */
    gasAteIt: 0,
    /** Net positive but below MIN_PROFIT_USD. */
    belowMin: 0,
    /** Same route reverted on-chain recently; muted for 20 minutes. */
    muted: 0,
    /** The learning engine skipped it: the route, a token or a pool keeps failing test runs. */
    learnedSkip: 0,
    /** Shares a pool (or classic pair) with a better route in the same block. */
    overlapping: 0,
    /** On-chain check passed (executor simulation or quoters). */
    verified: 0,
    reverted: 0,
    quoteMismatch: 0,
    /** No on-chain check possible (local maths only). */
    unverified: 0,
  };

  /** Verify multi-hop / CL routes: RouteExecutor.simulate() when available, else each hop against its DEX's quoter. */
  private async verifyRoutes(opps: Opportunity[], tag: number | "pending"): Promise<void> {
    // Routes touching a quote-only venue (e.g. PancakeSwap V3) can't be executed by the deployed
    // RouteExecutor, so verify them against the DEXes' own quoters instead of the executor sim: that marks
    // them quoter-ok (a genuine paper find) rather than executor-reverted (which would mute them), and the
    // live path still won't send them because it requires an executor-ok simulation.
    const quoteOnly: Opportunity[] = [];
    const executable: Opportunity[] = [];
    for (const o of opps) (this.routeQuoteOnly(o) ? quoteOnly : executable).push(o);
    await Promise.all([
      executable.length ? this.verifyRoutesVia(executable, tag, this.routeSimMode) : undefined,
      quoteOnly.length ? this.verifyRoutesVia(quoteOnly, tag, "quoter") : undefined,
    ]);
  }

  /** A route the deployed RouteExecutor cannot trade (any hop is on a quote-only venue such as PancakeSwap V3). */
  private routeQuoteOnly(o: Opportunity): boolean {
    if (!o.route) return false;
    return o.route.pools.some((a) => QUOTE_ONLY_KINDS.has(this.registry.pools.get(a)?.kind ?? ""));
  }

  /**
   * Run every simulate() call of a scan in one Multicall3 request (with the state override, when
   * the bytecode is injected) instead of one eth_call each. Each sub-call reverts on purpose; its
   * revert data comes back as returnData. Returns false when the batch itself failed, so the
   * caller falls back to one call per opportunity.
   */
  private async simulateBatch(
    items: Array<{ o: Opportunity; target: string; data: string }>,
    tag: number | "pending",
    overrides: Record<string, { code: string }> | undefined,
    iface: typeof executorIface,
  ): Promise<boolean> {
    let res: Array<{ success: boolean; returnData: string }>;
    try {
      res = await this.chain.multicall(
        items.map((x) => ({ target: x.target, callData: x.data, allowFailure: true })),
        tag,
        overrides,
        SIM_BATCH,
      );
    } catch (err) {
      log.debug("batched simulation failed, simulating one by one:", (err as Error).message.slice(0, 120));
      return false;
    }
    // Every sub-call "succeeding" with no data means the target has no code: the RPC ignored the
    // state override. Let the one-by-one path detect that and switch to quoters.
    if (overrides && res.every((r) => r.success && (r.returnData === "0x" || r.returnData === ""))) return false;
    // simulate() always reverts with data (Simulated or a reason). A batch where every call reverted
    // empty-handed says more about the batch (gas cap, a provider quirk) than about the routes: check
    // them one by one rather than muting them all.
    if (res.every((r) => !r.success && (r.returnData === "0x" || r.returnData === ""))) return false;
    items.forEach(({ o }, i) => {
      const r = res[i]!;
      if (r.success) {
        o.sim = "executor-revert";
        o.simDetail = "simulate() returned instead of reverting with Simulated(profit)";
        return;
      }
      applySimRevert(o, r.returnData, iface);
    });
    return true;
  }

  private async verifyRoutesVia(opps: Opportunity[], tag: number | "pending", mode: "executor" | "override" | "quoter"): Promise<void> {
    if (mode !== "quoter") {
      const target = mode === "executor" ? this.routeOpts!.routeExecutorAddress! : SIM_ROUTE_OVERRIDE_ADDRESS;
      const items = opps.map((o) => ({ o, target, data: routeExecutorIface.encodeFunctionData("simulate", [o.route!.tokens, this.hopStructs(o), o.amountIn, flashSourceId(this.routeOpts!.flashSource)]) }));
      if (await this.simulateBatch(items, tag, mode === "override" ? { [target]: { code: ROUTE_EXECUTOR_RUNTIME } } : undefined, routeExecutorIface)) return;
      await Promise.all(
        items.map(async ({ o, data }) => {
          try {
            if (mode === "override") await this.chain.callWithOverrides(target, data, tag, { [target]: { code: ROUTE_EXECUTOR_RUNTIME } });
            else await this.chain.call(target, data, tag);
            o.sim = "executor-revert";
            o.simDetail = "simulate() returned instead of reverting with Simulated(profit)";
          } catch (err) {
            const e = err as { data?: string; message?: string; error?: { data?: string }; info?: { error?: { data?: string } } };
            const revertData = e.data ?? e.error?.data ?? e.info?.error?.data;
            if (typeof revertData === "string") {
              applySimRevert(o, revertData, routeExecutorIface);
              return;
            }
            o.sim = "executor-revert";
            o.simDetail = (e.message ?? "unknown revert").slice(0, 160);
          }
        }),
      );
      return;
    }
    const calls: Call[] = [];
    const index: Array<{ o: Opportunity; hop: number; at: number }> = [];
    for (const o of opps) {
      const r = o.route!;
      for (let i = 0; i < r.pools.length; i++) {
        const pool = this.registry.pools.get(r.pools[i]!);
        if (!pool) continue;
        index.push({ o, hop: i, at: calls.length });
        calls.push(hopQuoteCall(pool, r.tokens[i]!, r.tokens[i + 1]!, r.amounts[i]!));
      }
    }
    try {
      const res = await this.chain.multicall(calls, tag);
      const bad = new Map<Opportunity, string>();
      for (const { o, hop, at } of index) {
        const pool = this.registry.pools.get(o.route!.pools[hop]!)!;
        const got = decodeHopQuote(pool, res[at]!);
        const want = o.route!.amounts[hop + 1]!;
        if (got === null) bad.set(o, `hop ${hop + 1} (${pool.dex}) quoter call failed`);
        else if (got !== want && !bad.has(o)) bad.set(o, `hop ${hop + 1} (${pool.dex}) quoter ${got} vs local ${want}`);
      }
      for (const o of opps) {
        const why = bad.get(o);
        o.sim = why ? "quoter-mismatch" : "quoter-ok";
        if (why) o.simDetail = why;
      }
    } catch (err) {
      log.warn("route quoter verification failed:", (err as Error).message.slice(0, 120));
    }
  }

  /** (pool, kind, feePpm) tuples for RouteExecutor. */
  hopStructs(o: Opportunity): Array<{ pool: string; kind: number; feePpm: number }> {
    return o.route!.executorHops;
  }

  private recordFailure(o: Opportunity, block: number): void {
    const key = routeKeyOf(o);
    const f = this.failed.get(key) ?? { count: 0, until: 0 };
    f.count++;
    f.until = block + this.failureMuteBlocks;
    this.failed.set(key, f);
    if (o.route) {
      // A multi-hop route can fail for one bad hop; mute it (longer each time) rather than dropping every pool.
      f.until = block + this.failureMuteBlocks * f.count;
      log.info(`muting route ${o.pairSymbols} for ${this.failureMuteBlocks * f.count} blocks: simulation reverted (${o.simDetail ?? "no detail"})`);
      return;
    }
    if (f.count >= this.failuresBeforeDrop) {
      // The pair keeps failing real simulation (fee-on-transfer token, blacklist, broken pool): stop watching it.
      const dropped = [...this.registry.pools.values()].filter((p) => [p.token0, p.token1].sort().join("-") === o.pair);
      for (const p of dropped) this.registry.pools.delete(p.address);
      this.registry.dirty = true;
      log.warn(`dropping ${o.pairSymbols} (${dropped.length} pools): simulation reverted ${f.count} times (${o.simDetail ?? "no detail"})`);
    } else {
      log.info(`muting route ${o.pairSymbols} ${o.buyDex}->${o.sellDex} for ${this.failureMuteBlocks} blocks: simulation reverted (${o.simDetail ?? "no detail"})`);
    }
  }

  /**
   * Cross-check our numbers against the chain at the same block: with a
   * deployed executor, run its simulate() (exact, includes transfer quirks);
   * otherwise ask each DEX's own quoter for the two hops.
   */
  private async verify(opps: Opportunity[], block: number | "pending"): Promise<void> {
    if (this.simMode === "executor" || this.simMode === "override") {
      const override = this.simMode === "override";
      const target = override ? SIM_OVERRIDE_ADDRESS : this.executorAddress!;
      const items = opps.map((o) => ({ o, target, data: executorIface.encodeFunctionData("simulate", [o.buyPool, o.sellPool, o.tokenIn, o.amountIn, o.amountMid, o.amountOut, true]) }));
      if (await this.simulateBatch(items, block, override ? { [target]: { code: SIM_EXECUTOR_RUNTIME } } : undefined, executorIface)) return;
    }
    if (this.simMode === "executor") {
      await Promise.all(opps.map((o) => this.verifyWithExecutor(o, block, this.executorAddress!)));
      return;
    }
    if (this.simMode === "override") {
      await Promise.all(opps.map((o) => this.verifyWithExecutor(o, block, SIM_OVERRIDE_ADDRESS, { [SIM_OVERRIDE_ADDRESS]: { code: SIM_EXECUTOR_RUNTIME } })));
      // If the RPC rejected state overrides we fell back for this block; verify with quoters instead.
      if (this.simMode !== "override") await this.verify(opps, block);
      return;
    }
    const calls: Call[] = [];
    for (const o of opps) {
      const buy = this.registry.pools.get(o.buyPool)!;
      const sell = this.registry.pools.get(o.sellPool)!;
      calls.push(quoterCall(buy, o.tokenIn, o.amountIn));
      calls.push(quoterCall(sell, o.tokenMid, o.amountMid));
    }
    try {
      const res = await this.chain.multicall(calls, block);
      opps.forEach((o, i) => {
        const r1 = res[i * 2]!;
        const r2 = res[i * 2 + 1]!;
        const buy = this.registry.pools.get(o.buyPool)!;
        const sell = this.registry.pools.get(o.sellPool)!;
        const mid = decodeQuote(buy, r1);
        const out = decodeQuote(sell, r2);
        if (mid === null || out === null) {
          o.sim = "quoter-mismatch";
          o.simDetail = "quoter call failed";
          return;
        }
        if (mid === o.amountMid && out === o.amountOut) {
          o.sim = "quoter-ok";
        } else {
          o.sim = "quoter-mismatch";
          o.simDetail = `quoter mid=${mid} out=${out} vs local mid=${o.amountMid} out=${o.amountOut}`;
        }
      });
    } catch (err) {
      log.warn("quoter verification failed:", (err as Error).message);
    }
  }

  private async verifyWithExecutor(o: Opportunity, block: number | "pending", target: string, overrides?: Record<string, { code: string }>): Promise<void> {
    const data = executorIface.encodeFunctionData("simulate", [o.buyPool, o.sellPool, o.tokenIn, o.amountIn, o.amountMid, o.amountOut, true]);
    try {
      if (overrides) await this.chain.callWithOverrides(target, data, block, overrides);
      else await this.chain.call(target, data, block);
      o.sim = "executor-revert";
      o.simDetail = "simulate() did not revert with Simulated(profit) as expected";
    } catch (err) {
      const e = err as { data?: string; message?: string; error?: { data?: string }; info?: { error?: { message?: string; data?: string } } };
      const revertData = e.data ?? e.error?.data ?? e.info?.error?.data;
      if (overrides && typeof revertData !== "string") {
        // No revert data at all: the RPC most likely does not support state overrides.
        const msg = (e.info?.error?.message ?? e.message ?? "").toLowerCase();
        if (/override|invalid argument|too many arguments|unexpected|params|not supported|unsupported|invalid params/.test(msg) || msg.includes("missing revert data")) {
          if (this.simMode === "override") {
            log.warn(`state-override simulation not available on this RPC (${(e.info?.error?.message ?? e.message ?? "").slice(0, 100)}); falling back to quoter checks. Deploy ArbExecutor and set EXECUTOR_ADDRESS for exact simulation.`);
            this.simMode = "quoter";
          }
          o.sim = "local";
          return;
        }
      }
      if (typeof revertData === "string") {
        applySimRevert(o, revertData, executorIface);
        return;
      }
      o.sim = "executor-revert";
      o.simDetail = (e.message ?? "unknown revert").slice(0, 160);
    }
  }
}

/** simulate() calls per batched eth_call (each runs a full flash-loan route, so keep the gas per request sane). */
const SIM_BATCH = 20;

/** Read a simulate() revert: Simulated(profit) means it would have worked; anything else is why it wouldn't. */
function applySimRevert(o: Opportunity, revertData: string, iface: typeof executorIface): void {
  try {
    const parsed = iface.parseError(revertData);
    if (parsed?.name === "Simulated") {
      const profit = parsed.args[0] as bigint;
      o.sim = "executor-ok";
      o.simDetail = `on-chain profit ${profit}${profit !== o.profit ? ` (local ${o.profit})` : ""}`;
      return;
    }
    o.sim = "executor-revert";
    o.simDetail = parsed ? `${parsed.name}(${parsed.args.map(String).join(",")})` : revertData.slice(0, 20) || "reverted without data";
  } catch {
    o.sim = "executor-revert";
    o.simDetail = revertData && revertData !== "0x" ? revertData.slice(0, 20) : "reverted without data";
  }
}

/** Pools grouped by unordered token pair (like PoolRegistry.groups, over any list). */
function groupByPair(pools: Iterable<Pool>): Map<string, Pool[]> {
  const g = new Map<string, Pool[]>();
  for (const p of pools) {
    const k = pairKey(p.token0, p.token1);
    const arr = g.get(k);
    if (arr) arr.push(p);
    else g.set(k, [p]);
  }
  return g;
}

function quoterCall(pool: Pool, tokenIn: string, amountIn: bigint): Call {
  if (pool.kind === "aerodrome") {
    return { target: pool.address, callData: aeroPoolIface.encodeFunctionData("getAmountOut", [amountIn, tokenIn]) };
  }
  const dex = DEXES.find((d) => d.id === pool.dex)!;
  const tokenOut = tokenIn.toLowerCase() === pool.token0 ? pool.token1 : pool.token0;
  return { target: dex.router, callData: univ2RouterIface.encodeFunctionData("getAmountsOut", [amountIn, [tokenIn, tokenOut]]) };
}

function decodeQuote(pool: Pool, r: { success: boolean; returnData: string }): bigint | null {
  if (!r.success || r.returnData.length < 66) return null;
  if (pool.kind === "aerodrome") return abi.decode(["uint256"], r.returnData)[0] as bigint;
  const amounts = abi.decode(["uint256[]"], r.returnData)[0] as bigint[];
  return amounts[amounts.length - 1] ?? null;
}

const MIN_SQRT_PLUS_ONE = 4295128740n;
const MAX_SQRT_MINUS_ONE = 1461446703485210103287273052203988822378723970341n;

/** One exact-input quote for a hop, using the pool type's own on-chain quoter. */
function hopQuoteCall(pool: Pool, tokenIn: string, tokenOut: string, amountIn: bigint): Call {
  if (pool.v4) {
    // V4Quoter takes the PoolKey (real currencies, native ETH as 0x0) + direction, not a univ3-style quote.
    // tokenIn is the graph token (native ETH shows as WETH); token0 is the graph token for currency0.
    const zeroForOne = tokenIn.toLowerCase() === pool.token0;
    const params = {
      poolKey: { currency0: pool.v4.currency0, currency1: pool.v4.currency1, fee: pool.v4.fee, tickSpacing: pool.v4.tickSpacing, hooks: pool.v4.hooks },
      zeroForOne,
      exactAmount: amountIn,
      hookData: "0x",
    };
    return { target: pool.cl!.quoter, callData: v4QuoterIface.encodeFunctionData("quoteExactInputSingle", [params]) };
  }
  if (pool.cl) {
    const zeroForOne = tokenIn === pool.token0;
    const limit = zeroForOne ? MIN_SQRT_PLUS_ONE : MAX_SQRT_MINUS_ONE;
    // QuoterV2 treats a zero limit as "no limit"; pass it explicitly anyway so both quoters behave alike.
    if (pool.kind === "slipstream") {
      return { target: pool.cl.quoter, callData: slipstreamQuoterIface.encodeFunctionData("quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn, tickSpacing: pool.cl.tickSpacing, sqrtPriceLimitX96: limit }]) };
    }
    return { target: pool.cl.quoter, callData: univ3QuoterIface.encodeFunctionData("quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn, fee: pool.cl.feePips, sqrtPriceLimitX96: limit }]) };
  }
  return quoterCall(pool, tokenIn, amountIn);
}

function decodeHopQuote(pool: Pool, r: { success: boolean; returnData: string }): bigint | null {
  if (!pool.cl) return decodeQuote(pool, r);
  if (!r.success || r.returnData.length < 66) return null;
  return abi.decode(["uint256"], r.returnData.slice(0, 66))[0] as bigint;
}
