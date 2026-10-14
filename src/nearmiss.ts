/**
 * Near misses: candidates the scanner dropped for gas or the profit minimum
 * but that came close. Written to data/near-misses.jsonl, at most 5 per block
 * (the best net value), so we can see what a lower MIN_PROFIT_USD, cheaper gas
 * or a better size would have bought.
 *
 *   { block, at, code, pairSymbols, dexes, amountIn, profitUsd, gasUsd, netUsd, ... }
 *
 * `code` is the FUNNEL_STAGES code (src/digest.ts) of the stage that dropped
 * it: NET_NEGATIVE_AFTER_GAS (net < 0) or NET_PROFIT_TOO_LOW (0 <= net < min).
 *
 * "Close" means net >= MIN_PROFIT_USD * (1 - band), band = NEAR_MISS_BAND
 * (default 0.5). With the default only NET_PROFIT_TOO_LOW can qualify; a band
 * above 1 also admits gas-negative candidates (band 1.5 -> net >= -0.5 * min).
 *
 * Off unless NEAR_MISSES=true. Paper bookkeeping only; never sends anything.
 *
 * Cost per candidate: one comparison when out of band; when in band, one
 * closure call and an insert into a 5-slot buffer. Records are written when
 * the next block number is seen (flashblock scans of the same block share its
 * 5 slots and are de-duplicated by route).
 */
import { FUNNEL_STAGES } from "./digest.js";
import type { Store } from "./store.js";

export const NEAR_MISSES_FILE = "near-misses.jsonl";

const code = (key: string): string => FUNNEL_STAGES.find((s) => s.key === key)?.code ?? key;
export const NEAR_MISS_CODES = { gas: code("gasAteIt"), low: code("belowMin") } as const;

export interface NearMissInfo {
  /** Route identity for de-duplication within a block (scanner routeKey). */
  key: string;
  pairSymbols: string;
  dexes: string[];
  tokenInSymbol: string;
  amountIn: bigint;
  profitUsd: number;
  gasUsd: number;
  hops: number;
  stage?: "block" | "flashblock" | undefined;
}

export interface NearMissRecord {
  block: number;
  at: string;
  code: string;
  pairSymbols: string;
  dexes: string[];
  amountIn: string;
  profitUsd: number;
  gasUsd: number;
  netUsd: number;
  /** MIN_PROFIT_USD in force, and how far short the candidate was. */
  minProfitUsd: number;
  shortUsd: number;
  tokenInSymbol: string;
  hops: number;
  stage: "block" | "flashblock";
}

export interface NearMissOptions {
  perBlock?: number;
  band?: number;
  file?: string;
}

export class NearMissCollector {
  readonly perBlock: number;
  readonly band: number;
  readonly file: string;
  private block = -1;
  private buf: NearMissRecord[] = [];
  private keys: string[] = [];
  /** Since start. */
  readonly stats = { offered: 0, inBand: 0, written: 0 };

  constructor(readonly store: Store, opts: NearMissOptions = {}) {
    this.perBlock = opts.perBlock ?? 5;
    this.band = opts.band ?? 0.5;
    this.file = opts.file ?? NEAR_MISSES_FILE;
  }

  /** Lowest net value that still counts as a near miss for this minimum (null: none can). */
  floor(minNetUsd: number): number | null {
    if (!Number.isFinite(minNetUsd) || minNetUsd <= 0) return null;
    return minNetUsd * (1 - this.band);
  }

  /**
   * A candidate the scanner is about to drop. `info` is only called when the
   * candidate is in band and good enough for this block's buffer.
   */
  offer(block: number, netUsd: number, minNetUsd: number, info: () => NearMissInfo): void {
    this.stats.offered++;
    if (block !== this.block) this.flush(block);
    if (!(netUsd < minNetUsd)) return;
    const floor = this.floor(minNetUsd);
    if (floor === null || netUsd < floor) return;
    this.stats.inBand++;
    const b = this.buf;
    if (b.length >= this.perBlock && netUsd <= b[b.length - 1]!.netUsd) return;
    const i = info();
    const dup = this.keys.indexOf(i.key);
    if (dup >= 0) {
      if (b[dup]!.netUsd >= netUsd) return;
      b.splice(dup, 1);
      this.keys.splice(dup, 1);
    }
    const rec: NearMissRecord = {
      block,
      at: new Date().toISOString(),
      code: netUsd < 0 ? NEAR_MISS_CODES.gas : NEAR_MISS_CODES.low,
      pairSymbols: i.pairSymbols,
      dexes: i.dexes,
      amountIn: i.amountIn.toString(),
      profitUsd: i.profitUsd,
      gasUsd: i.gasUsd,
      netUsd,
      minProfitUsd: minNetUsd,
      shortUsd: minNetUsd - netUsd,
      tokenInSymbol: i.tokenInSymbol,
      hops: i.hops,
      stage: i.stage ?? "block",
    };
    // Insert sorted by net, best first.
    let at = b.length;
    while (at > 0 && b[at - 1]!.netUsd < netUsd) at--;
    b.splice(at, 0, rec);
    this.keys.splice(at, 0, i.key);
    if (b.length > this.perBlock) {
      b.length = this.perBlock;
      this.keys.length = this.perBlock;
    }
  }

  /** Write the buffered block (called automatically when a new block number is offered). */
  flush(nextBlock = -1): void {
    for (const r of this.buf) {
      try {
        this.store.append(this.file, r);
        this.stats.written++;
      } catch {
        /* a full disk must not stop the scanner */
      }
    }
    this.buf = [];
    this.keys = [];
    this.block = nextBlock;
  }

  /** Records waiting for the block to end (tests, dashboard). */
  pending(): readonly NearMissRecord[] {
    return this.buf;
  }
}

/** A collector when NEAR_MISSES=true, else undefined. NEAR_MISS_BAND overrides the 0.5 band. */
export function nearMissesFromEnv(store: Store, env: Record<string, string | undefined> = process.env): NearMissCollector | undefined {
  if ((env.NEAR_MISSES ?? "false").toLowerCase() !== "true") return undefined;
  const band = Number(env.NEAR_MISS_BAND);
  return new NearMissCollector(store, Number.isFinite(band) && band > 0 ? { band } : {});
}
