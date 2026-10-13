/**
 * Gap, cost and net for every (asset, chain pair). Pure functions: no I/O, easy to test.
 *
 *   gapBps  = |pA - pB| / min(pA, pB) * 10 000          (always >= 0; buyOn is the cheaper chain)
 *   costBps = bridge bps + both pools' swap fees
 *           + (swap gas on both chains + bridge fixed USD) / notional * 10 000
 *   netBps  = gapBps - costBps;  window open when netBps > minNetBps
 *
 * The bridge part is charged on every check on purpose: an inventory strategy doesn't bridge per
 * trade, but it has to rebalance eventually, and charging it up front keeps the numbers honest.
 */
import type { AssetCfg, ChainCfg, Pool } from "./pools.ts";

export interface BridgeCost {
  label?: string;
  bps: { l2: number; eth: number };
  fixedUsd: { l2: number; eth: number };
}
export interface CostCfg {
  swapGasUsd: Record<string, number>;
  bridges: Record<string, BridgeCost>;
  /** keyed "a-b" (config chain order), e.g. "base-arb": override bridge bps / fixed USD for that pair */
  pairOverrides?: Record<string, { bridgeBps?: number; fixedUsd?: number }>;
}
export interface MonitorCfg {
  intervalMs: number;
  resolveEveryMin: number;
  notionalUsd: number;
  minNetBps: number;
  outDir: string;
  spreadsFile: string;
  metricsFile: string;
  maxFileMb: number;
  chains: Record<string, ChainCfg>;
  assets: AssetCfg[];
  costs: CostCfg;
}

/** One line of data/fleet/xchain-spreads.jsonl. */
export interface SpreadRecord {
  ts: string;
  asset: string;
  /** the two chains in config order, e.g. "base" and "arb" */
  a: string;
  b: string;
  pa: number;
  pb: number;
  buyOn: string;
  sellOn: string;
  gapBps: number;
  costBps: number;
  netBps: number;
  open: boolean;
  notionalUsd: number;
  /** net profit estimate at notionalUsd, never below 0 */
  estUsd: number;
  venues: [string, string];
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Every unordered pair of chains, in config order. */
export function chainPairs(chains: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < chains.length; i++) for (let j = i + 1; j < chains.length; j++) out.push([chains[i]!, chains[j]!]);
  return out;
}

export function costBps(
  costs: CostCfg,
  asset: AssetCfg,
  a: string,
  b: string,
  feeBpsA: number,
  feeBpsB: number,
  notionalUsd: number,
): number {
  const bridge = costs.bridges[asset.bridge];
  const side = a === "eth" || b === "eth" ? "eth" : "l2";
  const ov = costs.pairOverrides?.[`${a}-${b}`] ?? {};
  const bridgeBps = ov.bridgeBps ?? bridge?.bps[side] ?? 0;
  const fixed = ov.fixedUsd ?? bridge?.fixedUsd[side] ?? 0;
  const gas = (costs.swapGasUsd[a] ?? 0) + (costs.swapGasUsd[b] ?? 0);
  return bridgeBps + feeBpsA + feeBpsB + ((gas + fixed) / Math.max(1, notionalUsd)) * 10_000;
}

/**
 * Build one record per (asset, chain pair) where both sides have a pool and a finite price.
 * `prices` maps "chain|asset" to the price of the asset's base token in its quote token.
 */
export function computeChecks(
  cfg: Pick<MonitorCfg, "notionalUsd" | "minNetBps" | "assets" | "costs" | "chains">,
  pools: Map<string, Pool>,
  prices: Map<string, number>,
  now: Date,
): SpreadRecord[] {
  const out: SpreadRecord[] = [];
  const order = Object.keys(cfg.chains);
  for (const asset of cfg.assets) {
    for (const [a, b] of chainPairs(order)) {
      const pa = prices.get(`${a}|${asset.id}`);
      const pb = prices.get(`${b}|${asset.id}`);
      const poolA = pools.get(`${a}|${asset.id}`);
      const poolB = pools.get(`${b}|${asset.id}`);
      if (!poolA || !poolB || pa === undefined || pb === undefined) continue;
      if (!(pa > 0) || !(pb > 0) || !Number.isFinite(pa) || !Number.isFinite(pb)) continue;
      const gap = (Math.abs(pa - pb) / Math.min(pa, pb)) * 10_000;
      const cost = costBps(cfg.costs, asset, a, b, poolA.feeBps, poolB.feeBps, cfg.notionalUsd);
      const net = gap - cost;
      out.push({
        ts: now.toISOString(),
        asset: asset.id,
        a,
        b,
        pa,
        pb,
        buyOn: pa <= pb ? a : b,
        sellOn: pa <= pb ? b : a,
        gapBps: r2(gap),
        costBps: r2(cost),
        netBps: r2(net),
        open: net > cfg.minNetBps,
        notionalUsd: cfg.notionalUsd,
        estUsd: r2((Math.max(0, net) / 10_000) * cfg.notionalUsd),
        venues: [poolA.venue, poolB.venue],
      });
    }
  }
  return out;
}
