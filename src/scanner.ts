/**
 * Per-block opportunity search: for every token pair that lives on two or
 * more watched pools, quote both directions and both pool orderings, price the
 * profit in USD, subtract the estimated gas, and rank.
 */
import { AbiCoder } from "ethers";
import { DEXES, USDC, WETH } from "./config.js";
import { aeroPoolIface, univ2RouterIface, executorIface, routeExecutorIface, univ3QuoterIface, slipstreamQuoterIface } from "./abi.js";
import { quoteArb, type ArbQuote } from "./math.js";
import { findCycles, optimizeRoute, routeLabel, type RouteQuote } from "./routes.js";
import { SIM_EXECUTOR_RUNTIME } from "./simBytecode.js";
import { ROUTE_EXECUTOR_RUNTIME } from "./simBytecodeRoute.js";
import type { Pool, PoolRegistry } from "./pools.js";
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

const routeKeyOf = routeKey;

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
  /** Blocks a reverting route stays muted (600 blocks = 20 minutes). */
  failureMuteBlocks = 600;
  /** After this many revert failures the token pair's pools are dropped from the watch list. */
  failuresBeforeDrop = 3;

  /** Routes found in the last scan before the profit floor (used to pick "hot" pools for Flashblocks). */
  lastCandidatePools = new Set<string>();

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

  /**
   * Multi-hop and concentrated-liquidity routes. Pure V2 two-pool routes are
   * left to findRaw() (they run through the original ArbExecutor).
   */
  findRoutes(pools?: Iterable<Pool>): RouteQuote<Pool>[] {
    const o = this.routeOpts;
    if (!o || !o.multiHop) return [];
    const cycles = findCycles<Pool>(pools ?? this.registry.pools.values(), {
      startTokens: [WETH, USDC],
      maxHops: o.maxHops,
      exclude: (ps) => ps.length === 2 && ps.every((p) => !(p as Pool).cl),
      maxCycles: o.maxCycles,
    });
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

  /** All positive-profit routes at the current reserve snapshot, before gas. */
  findRaw(maxAmountInWeth?: bigint, only?: Set<string>): ArbQuote[] {
    const quotes: ArbQuote[] = [];
    for (const [, all] of this.registry.groups()) {
      const pools = all.filter((p) => !p.cl && (!only || only.has(p.address)));
      if (pools.length < 2) continue;
      for (let i = 0; i < pools.length; i++) {
        for (let j = 0; j < pools.length; j++) {
          if (i === j) continue;
          const buy = pools[i]!;
          const sell = pools[j]!;
          if (buy.reserve0 === 0n || sell.reserve0 === 0n) continue;
          for (const tokenIn of [buy.token0, buy.token1]) {
            const cap = tokenIn === WETH ? maxAmountInWeth : undefined;
            const q = quoteArb(buy, sell, tokenIn, cap);
            if (q) quotes.push(q);
          }
        }
      }
    }
    return quotes;
  }

  /** Price, gas-adjust and rank; returns opportunities above `minNetUsd`. */
  async scan(
    block: number,
    gas: GasQuote,
    ethUsd: number,
    minNetUsd: number,
    opts: { blockTag?: number | "pending"; only?: Set<string>; stage?: "block" | "flashblock"; msIntoBlock?: number } = {},
  ): Promise<Opportunity[]> {
    const raw = this.findRaw(undefined, opts.only);
    const subset = opts.only ? [...opts.only].map((a) => this.registry.pools.get(a)).filter((p): p is Pool => !!p) : undefined;
    const routes = this.findRoutes(subset);
    const gasUsd = weiToUsd(gas.totalWei, ethUsd);
    const gasPrice = gas.baseFeeWei + gas.priorityFeeWei;
    const opps: Opportunity[] = [];
    this.lastCandidatePools = new Set([...raw.flatMap((q) => [q.buyPool.address, q.sellPool.address]), ...routes.flatMap((r) => r.pools.map((p) => p.address))]);
    for (const r of routes) {
      const tokenIn = r.tokens[0]!;
      const profitUsd = this.registry.usdValue(tokenIn, r.profit, ethUsd);
      if (profitUsd === null) continue;
      const routeGasUsd = weiToUsd(BigInt(this.routeGasUnits(r.pools)) * gasPrice + gas.l1FeeWei, ethUsd);
      const netUsd = profitUsd - routeGasUsd;
      if (netUsd < minNetUsd) continue;
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
          executorHops: r.pools.map((p) => ({ pool: p.address, kind: hopKind(p), feePpm: Math.max(0, p.feePpm) })),
        },
      });
    }
    for (const q of raw) {
      const profitUsd = this.registry.usdValue(q.tokenIn, q.profit, ethUsd);
      if (profitUsd === null) continue; // cannot price -> cannot judge; skip
      const netUsd = profitUsd - gasUsd;
      if (netUsd < minNetUsd) continue;
      const buy = q.buyPool as Pool;
      const sell = q.sellPool as Pool;
      const pair = [buy.token0, buy.token1].sort().join("-");
      opps.push({
        id: `${block}-${buy.address.slice(2, 10)}-${sell.address.slice(2, 10)}-${q.tokenIn.slice(2, 8)}`,
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
    opps.sort((a, b) => b.netUsd - a.netUsd);
    // Routes that share a pool compete for the same reserves, so only one of them can be
    // taken: keep the most profitable and drop any later route touching a pool already used.
    // Classic routes also keep at most one per token pair, as before.
    // Routes whose on-chain simulation reverted recently are skipped entirely.
    const seen = new Set<string>();
    const usedPools = new Set<string>();
    const unique = opps.filter((o) => {
      const f = this.failed.get(routeKeyOf(o));
      if (f && f.until > block) return false;
      if (!o.route && seen.has(o.pair)) return false;
      const ps = poolsOf(o);
      if (ps.some((p) => usedPools.has(p))) return false;
      if (!o.route) seen.add(o.pair);
      for (const p of ps) usedPools.add(p);
      return true;
    });
    const tag = opts.blockTag ?? block;
    const classic = unique.filter((o) => !o.route);
    const multi = unique.filter((o) => o.route);
    await Promise.all([classic.length ? this.verify(classic, tag) : undefined, multi.length ? this.verifyRoutes(multi, tag) : undefined]);
    for (const o of unique) if (o.sim === "executor-revert") this.recordFailure(o, block);
    return unique;
  }

  /** Verify multi-hop / CL routes: RouteExecutor.simulate() when available, else each hop against its DEX's quoter. */
  private async verifyRoutes(opps: Opportunity[], tag: number | "pending"): Promise<void> {
    const mode = this.routeSimMode;
    if (mode !== "quoter") {
      await Promise.all(
        opps.map(async (o) => {
          const target = mode === "executor" ? this.routeOpts!.routeExecutorAddress! : SIM_ROUTE_OVERRIDE_ADDRESS;
          const data = routeExecutorIface.encodeFunctionData("simulate", [o.route!.tokens, this.hopStructs(o), o.amountIn, flashSourceId(this.routeOpts!.flashSource)]);
          try {
            if (mode === "override") await this.chain.callWithOverrides(target, data, tag, { [target]: { code: ROUTE_EXECUTOR_RUNTIME } });
            else await this.chain.call(target, data, tag);
            o.sim = "executor-revert";
            o.simDetail = "simulate() returned instead of reverting with Simulated(profit)";
          } catch (err) {
            const e = err as { data?: string; message?: string; error?: { data?: string }; info?: { error?: { data?: string } } };
            const revertData = e.data ?? e.error?.data ?? e.info?.error?.data;
            if (typeof revertData === "string") {
              try {
                const parsed = routeExecutorIface.parseError(revertData);
                if (parsed?.name === "Simulated") {
                  o.sim = "executor-ok";
                  o.simDetail = `on-chain profit ${parsed.args[0]}${parsed.args[0] !== o.profit ? ` (local ${o.profit})` : ""}`;
                  return;
                }
                o.sim = "executor-revert";
                o.simDetail = parsed ? `${parsed.name}(${parsed.args.map(String).join(",")})` : revertData.slice(0, 20);
                return;
              } catch {
                /* fall through */
              }
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
        try {
          const parsed = executorIface.parseError(revertData);
          if (parsed?.name === "Simulated") {
            const profit = parsed.args[0] as bigint;
            o.sim = "executor-ok";
            o.simDetail = `on-chain profit ${profit}`;
            if (profit !== o.profit) o.simDetail += ` (local ${o.profit})`;
            return;
          }
          o.sim = "executor-revert";
          o.simDetail = parsed ? `${parsed.name}(${parsed.args.map(String).join(",")})` : revertData.slice(0, 20);
          return;
        } catch {
          /* fall through */
        }
      }
      o.sim = "executor-revert";
      o.simDetail = (e.message ?? "unknown revert").slice(0, 160);
    }
  }
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
