/**
 * Per-block opportunity search: for every token pair that lives on two or
 * more watched pools, quote both directions and both pool orderings, price the
 * profit in USD, subtract the estimated gas, and rank.
 */
import { AbiCoder } from "ethers";
import { DEXES, WETH } from "./config.js";
import { aeroPoolIface, univ2RouterIface, executorIface } from "./abi.js";
import { quoteArb, type ArbQuote } from "./math.js";
import { SIM_EXECUTOR_RUNTIME } from "./simBytecode.js";
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
}

/** Address that has no code on Base; the simulation bytecode is injected here via eth_call state override. */
export const SIM_OVERRIDE_ADDRESS = "0x00000000000000000000000000000000a4b17e51";

const routeKeyOf = (o: { buyPool: string; sellPool: string; tokenIn: string }): string => `${o.buyPool}-${o.sellPool}-${o.tokenIn}`;

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

  constructor(readonly chain: Chain, readonly registry: PoolRegistry, readonly executorAddress?: string, useOverride = true) {
    this.simMode = executorAddress ? "executor" : useOverride ? "override" : "quoter";
  }

  /** All positive-profit routes at the current reserve snapshot, before gas. */
  findRaw(maxAmountInWeth?: bigint): ArbQuote[] {
    const quotes: ArbQuote[] = [];
    for (const [, pools] of this.registry.groups()) {
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
  async scan(block: number, gas: GasQuote, ethUsd: number, minNetUsd: number): Promise<Opportunity[]> {
    const raw = this.findRaw();
    const gasUsd = weiToUsd(gas.totalWei, ethUsd);
    const opps: Opportunity[] = [];
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
      });
    }
    opps.sort((a, b) => b.netUsd - a.netUsd);
    // Keep the best route per token pair: they share reserves, so only one can be taken.
    // Routes whose on-chain simulation reverted recently are skipped entirely.
    const seen = new Set<string>();
    const unique = opps.filter((o) => {
      const f = this.failed.get(routeKeyOf(o));
      if (f && f.until > block) return false;
      if (seen.has(o.pair)) return false;
      seen.add(o.pair);
      return true;
    });
    if (unique.length) await this.verify(unique, block);
    for (const o of unique) if (o.sim === "executor-revert") this.recordFailure(o, block);
    return unique;
  }

  private recordFailure(o: Opportunity, block: number): void {
    const key = routeKeyOf(o);
    const f = this.failed.get(key) ?? { count: 0, until: 0 };
    f.count++;
    f.until = block + this.failureMuteBlocks;
    this.failed.set(key, f);
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
  private async verify(opps: Opportunity[], block: number): Promise<void> {
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

  private async verifyWithExecutor(o: Opportunity, block: number, target: string, overrides?: Record<string, { code: string }>): Promise<void> {
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
