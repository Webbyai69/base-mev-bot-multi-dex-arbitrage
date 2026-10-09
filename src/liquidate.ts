/**
 * Turning a liquidatable Aave position into a sendable plan: find a swap path
 * for the seized collateral back to the debt asset, then simulate the whole
 * liquidation on-chain (flash-loan -> liquidationCall -> swap -> repay) before
 * sending. Latency-tolerant, which is why it suits a home PC — unlike arb
 * backruns, a liquidation stays open for seconds, not one 200 ms sub-block.
 */
import { liquidationExecutorIface } from "./abi.js";
import { WETH, USDC } from "./config.js";
import { hopKind } from "./scanner.js";
import { pairKey, type Pool, type PoolRegistry } from "./pools.js";
import { LIQ_EXECUTOR_RUNTIME } from "./simBytecodeLiquidation.js";
import type { Chain } from "./rpc.js";
import type { LiquidationPlan } from "./executor.js";
import { log } from "./log.js";

/** A liquidatable position the monitor found, with the raw amount to repay. */
export interface LiquidatablePosition {
  id: string;
  block: number;
  user: string;
  collateralAsset: string;
  collateralSymbol: string;
  debtAsset: string;
  debtSymbol: string;
  /** Debt to repay, in debt-token units. */
  debtToCover: bigint;
  estProfitUsd: number;
}

const hopFor = (p: Pool) => ({ pool: p.address, kind: hopKind(p), feePpm: Math.max(0, p.feePpm) });
const depth = (p: Pool) => (p.reserve0 > p.reserve1 ? p.reserve0 : p.reserve1);

/** Deepest pool holding exactly this unordered pair, or undefined. */
function bestPool(registry: PoolRegistry, a: string, b: string): Pool | undefined {
  const group = registry.groups().get(pairKey(a, b));
  if (!group || !group.length) return undefined;
  return [...group].filter((p) => p.reserve0 > 0n && p.reserve1 > 0n).sort((x, y) => (depth(y) > depth(x) ? 1 : -1))[0];
}

/**
 * A swap path [collateral, …, debt] and its hops: a direct pool if one exists,
 * else through WETH or USDC (the assets with deep pools on Base). null if no
 * route is found — we skip rather than guess.
 */
export function planSwap(registry: PoolRegistry, collateral: string, debt: string): { tokens: string[]; hops: Array<{ pool: string; kind: number; feePpm: number }> } | null {
  const c = collateral.toLowerCase();
  const d = debt.toLowerCase();
  if (c === d) return null; // you never liquidate a debt with the same asset as collateral
  const direct = bestPool(registry, c, d);
  if (direct) return { tokens: [c, d], hops: [hopFor(direct)] };
  for (const mid of [WETH, USDC]) {
    if (mid === c || mid === d) continue;
    const first = bestPool(registry, c, mid);
    const second = bestPool(registry, mid, d);
    if (first && second) return { tokens: [c, mid, d], hops: [hopFor(first), hopFor(second)] };
  }
  return null;
}

/**
 * Run the whole liquidation read-only with eth_call (the executor bytecode
 * injected at a fake address via state override, or the deployed contract) to
 * get the exact debt-asset profit. Returns null if it wouldn't profit.
 */
export async function simulateLiquidation(
  chain: Chain,
  pos: LiquidatablePosition,
  swap: { tokens: string[]; hops: Array<{ pool: string; kind: number; feePpm: number }> },
  opts: { liqExecutorAddress?: string; source: number },
  block: number | "latest" = "latest",
): Promise<bigint | null> {
  const liq = [pos.collateralAsset, pos.debtAsset, pos.user, pos.debtToCover];
  const hops = swap.hops.map((h) => [h.pool, h.kind, h.feePpm] as const);
  const data = liquidationExecutorIface.encodeFunctionData("simulate", [liq, swap.tokens, hops, opts.source]);
  const FAKE = "0x00000000000000000000000000000000a4b17e53";
  const target = opts.liqExecutorAddress ?? FAKE;
  try {
    if (opts.liqExecutorAddress) await chain.call(target, data, block);
    else await chain.callWithOverrides(target, data, block, { [target]: { code: LIQ_EXECUTOR_RUNTIME } });
    return null; // simulate() must revert with Simulated(profit); a plain return means no profit path
  } catch (err) {
    const e = err as { data?: string; message?: string; error?: { data?: string }; info?: { error?: { data?: string } } };
    const revertData = e.data ?? e.error?.data ?? e.info?.error?.data;
    if (typeof revertData === "string") {
      try {
        const parsed = liquidationExecutorIface.parseError(revertData);
        if (parsed?.name === "Simulated") return parsed.args[0] as bigint;
      } catch {
        /* a real revert (position no longer liquidatable, swap too thin): no profit */
      }
    }
    return null;
  }
}

/**
 * Plan a live liquidation: find the swap, simulate it, and if it clears
 * `minProfitUsd` build the LiquidationPlan to send. Returns null (with a reason
 * logged) when it isn't worth sending.
 */
export async function planLiquidation(
  chain: Chain,
  registry: PoolRegistry,
  pos: LiquidatablePosition,
  ctx: { ethUsd: number; minProfitUsd: number; liqExecutorAddress?: string; source: number },
  block: number | "latest" = "latest",
): Promise<LiquidationPlan | null> {
  const swap = planSwap(registry, pos.collateralAsset, pos.debtAsset);
  if (!swap) {
    log.info(`liquidation: no swap route from ${pos.collateralSymbol} back to ${pos.debtSymbol}; skipping ${pos.user.slice(0, 10)}`);
    return null;
  }
  const profit = await simulateLiquidation(chain, pos, swap, { liqExecutorAddress: ctx.liqExecutorAddress, source: ctx.source }, block);
  if (profit === null || profit <= 0n) {
    log.info(`liquidation: on-chain simulation of ${pos.user.slice(0, 10)} didn't profit (position may have closed or the swap is too thin)`);
    return null;
  }
  const profitUsd = registry.usdValue(pos.debtAsset, profit, ctx.ethUsd) ?? 0;
  if (profitUsd < ctx.minProfitUsd) {
    log.info(`liquidation: ${pos.user.slice(0, 10)} simulates $${profitUsd.toFixed(2)} profit, below the $${ctx.minProfitUsd} floor; skipping`);
    return null;
  }
  // Require at least 80% of the simulated profit on-chain: a little drift is fine, a stale one reverts.
  const minProfit = (profit * 80n) / 100n;
  return {
    id: pos.id,
    block: pos.block,
    label: `liquidate ${pos.user.slice(0, 10)} ${pos.debtSymbol}->${pos.collateralSymbol}`,
    collateralAsset: pos.collateralAsset,
    debtAsset: pos.debtAsset,
    user: pos.user,
    debtToCover: pos.debtToCover,
    minProfit,
    swapTokens: swap.tokens,
    swapHops: swap.hops,
    expectedProfitUsd: profitUsd,
  };
}
