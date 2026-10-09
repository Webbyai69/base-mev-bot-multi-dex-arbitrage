/**
 * Flashblocks reaction loop (upgrade 3).
 *
 * Base builds each 2-second block as ~10 "flashblocks" of ~200ms, and its
 * Flashblocks-aware RPC endpoints (the public https://mainnet.base.org among
 * them) answer eth_call with the "pending" tag from the latest flashblock.
 * Base has no public mempool, so this is the earliest a searcher can see
 * that a large swap has knocked a pool out of line.
 *
 * Between confirmed blocks this loop re-reads a small set of "hot" pools at
 * the pending state every FLASHBLOCK_POLL_MS and rescans just those pools.
 * Hot pools are the ones that produced a positive spread (before gas) or were
 * touched by another bot's arbitrage in the last few blocks, plus every pool
 * sharing a token pair with them (the other side of a spread).
 *
 * Opportunities found here go into the same paper engine, tagged
 * stage = "flashblock", with the last confirmed block number. Their first
 * outcome check is therefore the next confirmed block — the block a
 * transaction sent at that moment would have landed in. The daily report
 * compares flashblock finds with block finds so you can see whether reacting
 * early actually wins more.
 *
 * Caveat from Base's docs (Oct 2026): Flashblocks is "planned for deprecation
 * in the upcoming Denim hardfork (not yet finalized)". This loop is off by
 * default (FLASHBLOCKS=false) and the bot does not depend on it.
 */
import type { Chain } from "./rpc.js";
import type { PoolRegistry } from "./pools.js";
import type { Scanner, Opportunity } from "./scanner.js";
import type { PaperEngine } from "./paper.js";
import type { GasQuote } from "./gas.js";
import { blocksFor, PRECONF_TAG } from "./blocktime.js";
import { log } from "./log.js";

export interface FlashblockContext {
  block: number;
  seenAt: number;
  gas: GasQuote;
  ethUsd: number;
}

export class FlashblockWatcher {
  /** pool -> last confirmed block it was "interesting" in */
  private recent = new Map<string, number>();
  private ctx: FlashblockContext | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastSignature = "";
  /** While the confirmed-block handler runs we stay out of its way (shared pool objects). */
  paused = false;
  /** Resolves when the current tick (if any) finishes; the block handler awaits it. */
  idle: Promise<void> = Promise.resolve();
  stats = { ticks: 0, scans: 0, skippedUnchanged: 0, opps: 0, errors: 0, maxMs: 0 };

  /** Optional live-send hook: evaluates the finds and sends one immediately (set by main in live mode). */
  private liveSend?: (opps: Opportunity[], ethUsd: number, stage: "flashblock") => void;

  constructor(
    readonly chain: Chain,
    readonly registry: PoolRegistry,
    readonly scanner: Scanner,
    readonly paper: PaperEngine,
    readonly opts: { pollMs: number; maxPools: number; minProfitUsd: number; memoryBlocks?: number },
  ) {}

  /** React to pre-confirmed finds by sending live, not just recording them on paper. */
  setLiveSend(fn: (opps: Opportunity[], ethUsd: number, stage: "flashblock") => void): void {
    this.liveSend = fn;
  }

  /** Called by the block handler after each confirmed block. */
  onConfirmedBlock(ctx: FlashblockContext, interestingPools: Iterable<string>): void {
    this.ctx = ctx;
    for (const p of interestingPools) this.recent.set(p, ctx.block);
    const keep = this.opts.memoryBlocks ?? blocksFor(60_000);
    for (const [p, b] of this.recent) if (ctx.block - b > keep) this.recent.delete(p);
    this.lastSignature = "";
  }

  /** The pools re-read on every tick (most recently interesting first, then their siblings). */
  hotPools(): Set<string> {
    const byRecency = [...this.recent.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
    const out = new Set<string>();
    for (const p of byRecency) {
      if (out.size >= this.opts.maxPools) break;
      for (const s of this.registry.siblings([p])) {
        if (out.size >= this.opts.maxPools) break;
        out.add(s);
      }
    }
    return out;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
    log.info(`flashblocks: re-reading hot pools at the pending state every ${this.opts.pollMs}ms (max ${this.opts.maxPools} pools)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running || this.paused || !this.ctx) return;
    const hot = this.hotPools();
    if (hot.size < 2) return;
    this.running = true;
    let done!: () => void;
    this.idle = new Promise<void>((r) => (done = r));
    const t0 = Date.now();
    const ctx = this.ctx;
    try {
      this.stats.ticks++;
      const pools = [...hot].map((a) => this.registry.pools.get(a)).filter((p): p is NonNullable<typeof p> => !!p);
      await this.registry.refreshReserves(pools, PRECONF_TAG, this.chain);
      if (this.paused || this.ctx !== ctx) return; // a new block arrived mid-read; its handler refreshes everything
      const sig = pools.map((p) => `${p.reserve0}:${p.reserve1}`).join("|");
      if (sig === this.lastSignature) {
        this.stats.skippedUnchanged++;
        return;
      }
      this.lastSignature = sig;
      this.stats.scans++;
      const opps = await this.scanner.scan(ctx.block, ctx.gas, ctx.ethUsd, this.opts.minProfitUsd, {
        blockTag: PRECONF_TAG,
        only: hot,
        stage: "flashblock",
        msIntoBlock: Date.now() - ctx.seenAt,
      });
      if (this.paused || this.ctx !== ctx) return;
      this.stats.opps += opps.length;
      if (opps.length) this.paper.register(opps);
      // Send the best eligible find now, 0.2s into the block instead of waiting for the full block.
      if (opps.length && this.liveSend) this.liveSend(opps, ctx.ethUsd, "flashblock");
    } catch (err) {
      this.stats.errors++;
      if (this.stats.errors % 20 === 1) log.warn("flashblocks tick failed:", (err as Error).message.slice(0, 140));
    } finally {
      const ms = Date.now() - t0;
      if (ms > this.stats.maxMs) this.stats.maxMs = ms;
      this.running = false;
      done();
    }
  }
}
