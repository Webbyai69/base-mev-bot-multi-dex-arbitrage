/**
 * Flashblocks reaction loop (upgrade 3).
 *
 * Base builds each 2-second block as ~10 "flashblocks" of ~200ms. Base has no
 * public mempool, so a flashblock is the earliest a searcher can see that a
 * large swap has knocked a pool out of line.
 *
 * Trigger: Base's Flashblocks websocket (FLASHBLOCKS_WS_URL, by default
 * wss://mainnet.flashblocks.base.org/ws) pushes every flashblock as it is
 * built, with the receipts — and so the logs — of its transactions. Each one
 * is handled the moment it arrives, ~300 a minute:
 *
 *   1. its Sync / Swap logs are applied to *copies* of the watched pools they
 *      touch (the "overlay"): the exact pending state, with no RPC at all.
 *      Liquidity changes (Mint/Burn/ModifyLiquidity) can't be settled from a
 *      log, so those pools sit out until the next confirmed block;
 *   2. only routes through a pool that just changed are re-scored, against
 *      the confirmed state with the overlay on top;
 *   3. finds are verified at the "pending" tag on FLASHBLOCKS_RPC_URL and go
 *      to the paper engine (and the live sender) tagged stage = "flashblock".
 *
 * The overlay never touches the registry's own pool objects, so this loop no
 * longer has to pause while the confirmed-block handler runs. (Before 0.9.1 it
 * paused for the whole handler — about 2 s, i.e. nearly all the time — and
 * re-read up to 120 hot pools through the public endpoint every 400 ms, which
 * the endpoint's pacing stretched past the next block, so the read was thrown
 * away. That was 16 scans in 78 minutes.) An overlay entry is dropped once the
 * confirmed handler has processed its block.
 *
 * Fallback: with FLASHBLOCKS_WS_URL=off, or while the stream is down, the old
 * poll runs instead — hot pools re-read at the pending state every
 * FLASHBLOCK_POLL_MS — but into copies too, and it re-scores only what changed.
 *
 * Opportunities carry the last confirmed block number, so their first outcome
 * check is the next confirmed block — the block a transaction sent at that
 * moment would have landed in.
 *
 * Caveat from Base's docs (Oct 2026): Flashblocks is "planned for deprecation
 * in the upcoming Denim hardfork (not yet finalized)". At Denim the 200ms
 * blocks become canonical and the confirmed-block loop takes over this job.
 */
import { createRequire } from "node:module";
import { brotliDecompressSync } from "node:zlib";
import type { Chain } from "./rpc.js";
import { applyStateLog, clonePool, poolKeyOfLog, poolStateSig, type Pool, type PoolRegistry, type StateLog } from "./pools.js";
import type { Scanner, Opportunity } from "./scanner.js";
import type { PaperEngine } from "./paper.js";
import type { GasQuote } from "./gas.js";
import { wordsNeeded } from "./clmath.js";
import { blocksFor, PRECONF_TAG } from "./blocktime.js";
import { log } from "./log.js";

export interface FlashblockContext {
  block: number;
  seenAt: number;
  gas: GasQuote;
  ethUsd: number;
}

/** One flashblock as the stream delivers it: which block it builds, its position, and its logs. */
export interface Flashblock {
  block: number;
  index: number;
  logs: StateLog[];
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/**
 * Decode one websocket message. Base sends JSON, brotli-compressed in binary frames (plain JSON
 * text is accepted too). The shape (Base docs, "Flashblocks"):
 *
 *   { payload_id, index, base?: { block_number: "0x…", … }, diff: { transactions, … },
 *     metadata: { block_number, receipts: { "0xtxhash": { "Eip1559": { status, logs: [{ address, topics, data }] } } } } }
 *
 * Receipts are keyed by transaction hash and wrapped in their type ("Legacy", "Eip1559",
 * "Deposit", …); some builds send them unwrapped, or as an array. All of those are read. Returns
 * null for anything that isn't a flashblock.
 */
export function parseFlashblock(raw: Buffer | ArrayBuffer | string): Flashblock | null {
  let text: string;
  if (typeof raw === "string") text = raw;
  else {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let i = 0;
    while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i++;
    text = buf[i] === 0x7b ? buf.toString("utf8") : brotliDecompressSync(buf).toString("utf8");
  }
  const m = JSON.parse(text) as {
    index?: number | string;
    base?: { block_number?: string | number };
    metadata?: { block_number?: string | number; receipts?: unknown };
  };
  const toNum = (x: unknown): number => (typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN);
  const block = toNum(m.metadata?.block_number ?? m.base?.block_number);
  const index = toNum(m.index ?? 0);
  if (!Number.isFinite(block) || block <= 0 || !Number.isFinite(index)) return null;
  const logs: StateLog[] = [];
  const receipts = m.metadata?.receipts;
  const list = Array.isArray(receipts) ? receipts : receipts && typeof receipts === "object" ? Object.values(receipts as Record<string, unknown>) : [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    let body = r as { logs?: unknown; status?: unknown };
    if (!Array.isArray(body.logs)) {
      // { "Eip1559": { …, logs } }: the receipt sits under its transaction type.
      const inner = Object.values(r as Record<string, unknown>).find((v) => v && typeof v === "object" && Array.isArray((v as { logs?: unknown }).logs));
      if (!inner) continue;
      body = inner as { logs?: unknown; status?: unknown };
    }
    // A reverted transaction changed nothing.
    if (body.status === "0x0" || body.status === 0 || body.status === false) continue;
    for (const l of body.logs as Array<{ address?: string; topics?: string[]; data?: string }>) {
      if (!l || typeof l.address !== "string" || !Array.isArray(l.topics)) continue;
      logs.push({ address: l.address.toLowerCase(), topics: l.topics.map((t) => String(t).toLowerCase()), data: typeof l.data === "string" ? l.data : "0x" });
    }
  }
  return { block, index, logs };
}

/** The bit of a websocket client this file uses (the `ws` package's, which ethers already depends on). */
export interface WsLike {
  on(event: string, fn: (...args: unknown[]) => void): void;
  terminate(): void;
}
type WsFactory = (url: string) => WsLike;

const defaultWs: WsFactory = (url) => {
  const require = createRequire(import.meta.url);
  const WS = require("ws") as new (url: string, opts?: Record<string, unknown>) => WsLike;
  return new WS(url, { perMessageDeflate: false, handshakeTimeout: 10_000 });
};

/** Keeps one connection to the Flashblocks websocket open, reconnecting with backoff; never throws into the bot. */
export class FlashblockStream {
  private ws: WsLike | undefined;
  private stopped = true;
  private retryMs = 1000;
  private quietTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  readonly stats = { connected: 0, messages: 0, parseErrors: 0, reconnects: 0, lastAt: 0 };
  lastError: string | null = null;

  constructor(
    readonly url: string,
    private onFlashblock: (fb: Flashblock) => void,
    private factory: WsFactory = defaultWs,
    /** No message for this long on an open socket = dead connection. */
    private quietMs = 15_000,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.quietTimer);
    clearTimeout(this.retryTimer);
    try {
      this.ws?.terminate();
    } catch {
      /* already gone */
    }
    this.ws = undefined;
    this.stats.connected = 0;
  }

  /** True while messages are arriving. */
  get live(): boolean {
    return this.stats.connected === 1 && Date.now() - this.stats.lastAt < this.quietMs;
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WsLike;
    try {
      ws = this.factory(this.url);
    } catch (err) {
      this.fail((err as Error).message);
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.stats.connected = 1;
      this.retryMs = 1000;
      this.lastError = null;
      this.armQuiet();
      log.info(`flashblocks: connected to ${redactWs(this.url)}`);
    });
    ws.on("message", (data: unknown) => {
      this.stats.messages++;
      this.stats.lastAt = Date.now();
      this.armQuiet();
      let fb: Flashblock | null = null;
      try {
        fb = parseFlashblock(Array.isArray(data) ? Buffer.concat(data as Buffer[]) : (data as Buffer | string));
      } catch (err) {
        this.stats.parseErrors++;
        if (this.stats.parseErrors % 100 === 1) log.warn("flashblocks: unreadable message:", (err as Error).message.slice(0, 120));
        return;
      }
      if (!fb) {
        this.stats.parseErrors++;
        if (this.stats.parseErrors % 100 === 1) log.warn("flashblocks: a message without a block number (the stream format may have changed)");
        return;
      }
      try {
        this.onFlashblock(fb);
      } catch (err) {
        log.warn("flashblocks: handler failed:", (err as Error).message.slice(0, 120));
      }
    });
    ws.on("error", (err: unknown) => {
      this.lastError = (err as Error)?.message ?? String(err);
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.fail(this.lastError ?? "closed");
    });
  }

  private armQuiet(): void {
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      log.warn(`flashblocks: no message for ${this.quietMs / 1000}s; reconnecting`);
      this.fail("quiet");
    }, this.quietMs);
    this.quietTimer.unref?.();
  }

  private fail(why: string): void {
    clearTimeout(this.quietTimer);
    const was = this.stats.connected;
    this.stats.connected = 0;
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.terminate();
    } catch {
      /* already gone */
    }
    if (this.stopped) return;
    this.lastError = why;
    this.stats.reconnects++;
    if (was || this.stats.reconnects <= 1 || this.stats.reconnects % 10 === 0) log.warn(`flashblocks: stream down (${why.slice(0, 80)}); retrying in ${Math.round(this.retryMs / 1000)}s`);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryTimer.unref?.();
    this.retryMs = Math.min(30_000, this.retryMs * 2);
  }
}

function redactWs(url: string): string {
  return url.replace(/([?&][a-z_-]*(?:key|token)[a-z_-]*=)[^&]+/gi, "$1…").replace(/\/[0-9a-f]{20,}.*/i, "/…");
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

/** Events per rolling minute (timestamps of the last 60 s). */
class PerMinute {
  private ts: number[] = [];
  add(now = Date.now()): void {
    this.ts.push(now);
    if (this.ts.length > 4000) this.ts.splice(0, this.ts.length - 4000);
  }
  rate(now = Date.now()): number {
    const from = now - 60_000;
    let i = 0;
    while (i < this.ts.length && this.ts[i]! < from) i++;
    if (i) this.ts.splice(0, i);
    return this.ts.length;
  }
}

export interface FlashblockStats {
  /** 1 while the websocket stream is delivering, 0 when it's down or off (the poll fallback runs then). */
  streaming: number;
  /** Flashblocks received, and those that changed at least one watched pool. */
  flashblocks: number;
  relevant: number;
  /** Flashblocks for a block the confirmed loop had already processed (nothing new in them). */
  stale: number;
  /** Re-scores run, and finds. */
  scans: number;
  opps: number;
  errors: number;
  /** Poll fallback: reads, and reads that found nothing changed. */
  ticks: number;
  skippedUnchanged: number;
  /** Rolling last-minute rates. */
  flashblocksPerMin: number;
  scansPerMin: number;
  /** Re-score time (find + verify), ms: average and worst since start. */
  avgMs: number;
  maxMs: number;
  /** Pools currently held at their pending state, and those left out until the next block. */
  overlayPools: number;
  unsettledPools: number;
  reconnects: number;
  /** ms since the last flashblock arrived (-1 = never). */
  lastFlashblockAgoMs: number;
}

export class FlashblockWatcher {
  /** pool -> last confirmed block it was "interesting" in (poll fallback only) */
  private recent = new Map<string, number>();
  private ctx: FlashblockContext | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private started = false;
  /** Pending copies of pools changed since the last confirmed block, with the block they were seen for. */
  private overlay = new Map<string, { pool: Pool; block: number }>();
  /** Pools whose pending liquidity is unknown (a Mint/Burn/ModifyLiquidity, or a tick outside the loaded words). */
  private unsettled = new Map<string, number>();
  /** Pools changed since the last re-score started; one re-score runs at a time, the next takes everything queued. */
  private queued = new Set<string>();
  private scanning = false;
  private stream: FlashblockStream | undefined;
  private fbRate = new PerMinute();
  private scanRate = new PerMinute();
  private totalMs = 0;
  private lastFlashblockAt = 0;
  private counts = { flashblocks: 0, relevant: 0, stale: 0, scans: 0, opps: 0, errors: 0, ticks: 0, skippedUnchanged: 0, maxMs: 0 };

  /** Kept for callers that still set it; the overlay design no longer needs to pause. */
  paused = false;
  /** Resolves when the current re-score (if any) finishes. */
  idle: Promise<void> = Promise.resolve();

  /** Optional live-send hook: evaluates the finds and sends one immediately (set by main in live mode). */
  private liveSend?: (opps: Opportunity[], ethUsd: number, stage: "flashblock") => void;

  /** Optional pool value-scorer (set by main): ranks the poll fallback's hot set. */
  private scoreOf?: (pool: string) => number;

  constructor(
    readonly chain: Chain,
    readonly registry: PoolRegistry,
    readonly scanner: Scanner,
    readonly paper: PaperEngine,
    readonly opts: { pollMs: number; maxPools: number; minProfitUsd: number; memoryBlocks?: number; wsUrl?: string | undefined; wsFactory?: WsFactory },
  ) {
    if (opts.wsUrl) this.stream = new FlashblockStream(opts.wsUrl, (fb) => this.onFlashblock(fb), opts.wsFactory);
  }

  /** React to pre-confirmed finds by sending live, not just recording them on paper. */
  setLiveSend(fn: (opps: Opportunity[], ethUsd: number, stage: "flashblock") => void): void {
    this.liveSend = fn;
  }

  /** Rank the poll fallback's hot set by this pool value-score instead of pure recency. */
  setScorer(fn: (pool: string) => number): void {
    this.scoreOf = fn;
  }

  /** Numbers for the dashboard and the digest. */
  get stats(): FlashblockStats {
    const now = Date.now();
    const c = this.counts;
    return {
      streaming: this.stream?.live ? 1 : 0,
      flashblocks: c.flashblocks,
      relevant: c.relevant,
      stale: c.stale,
      scans: c.scans,
      opps: c.opps,
      errors: c.errors,
      ticks: c.ticks,
      skippedUnchanged: c.skippedUnchanged,
      flashblocksPerMin: this.fbRate.rate(now),
      scansPerMin: this.scanRate.rate(now),
      avgMs: c.scans ? Math.round(this.totalMs / c.scans) : 0,
      maxMs: c.maxMs,
      overlayPools: this.overlay.size,
      unsettledPools: this.unsettled.size,
      reconnects: this.stream?.stats.reconnects ?? 0,
      lastFlashblockAgoMs: this.lastFlashblockAt ? now - this.lastFlashblockAt : -1,
    };
  }

  /**
   * Called by the block handler after each confirmed block: the confirmed state now includes every
   * flashblock of blocks <= block, so their pending copies are dropped.
   */
  onConfirmedBlock(ctx: FlashblockContext, interestingPools: Iterable<string>): void {
    this.ctx = ctx;
    for (const [a, e] of this.overlay) if (e.block <= ctx.block) this.overlay.delete(a);
    for (const [a, b] of this.unsettled) if (b <= ctx.block) this.unsettled.delete(a);
    for (const p of interestingPools) this.recent.set(p, ctx.block);
    const keep = this.opts.memoryBlocks ?? blocksFor(60_000);
    for (const [p, b] of this.recent) if (ctx.block - b > keep) this.recent.delete(p);
  }

  /** The pools the poll fallback re-reads: highest value-score first (then recency), then their siblings. */
  hotPools(): Set<string> {
    const score = this.scoreOf;
    const ranked = [...this.recent.entries()].sort((a, b) => (score ? score(b[0]) - score(a[0]) : 0) || b[1] - a[1]).map(([p]) => p);
    const out = new Set<string>();
    for (const p of ranked) {
      if (out.size >= this.opts.maxPools) break;
      for (const s of this.registry.siblings([p])) {
        if (out.size >= this.opts.maxPools) break;
        out.add(s);
      }
    }
    return out;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.stream) {
      this.stream.start();
      log.info(`flashblocks: re-scoring on every Flashblock from ${redactWs(this.stream.url)} (falls back to polling the pending state every ${this.opts.pollMs}ms while the stream is down)`);
    } else {
      log.info(`flashblocks: FLASHBLOCKS_WS_URL is off; re-reading hot pools at the pending state every ${this.opts.pollMs}ms (max ${this.opts.maxPools} pools)`);
    }
    const loop = () => {
      if (!this.started) return;
      // The poll is only the fallback: idle while the stream is delivering.
      const run = this.stream?.live ? Promise.resolve() : this.poll();
      void run.finally(() => {
        if (this.started) this.timer = setTimeout(loop, this.opts.pollMs);
      });
    };
    this.timer = setTimeout(loop, this.opts.pollMs);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.stream?.stop();
  }

  /** One flashblock from the stream: apply its logs to the overlay and re-score what they changed. */
  onFlashblock(fb: Flashblock): void {
    this.counts.flashblocks++;
    this.lastFlashblockAt = Date.now();
    this.fbRate.add(this.lastFlashblockAt);
    const ctx = this.ctx;
    if (!ctx) return; // nothing confirmed yet to build on
    if (fb.block <= ctx.block) {
      this.counts.stale++;
      return;
    }
    const changed = new Set<string>();
    for (const l of fb.logs) {
      const key = poolKeyOfLog(l);
      if (!key) continue;
      const base = this.registry.pools.get(key);
      if (!base) continue;
      const cur = this.overlay.get(key);
      const copy = cur ? cur.pool : clonePool(base);
      let r: ReturnType<typeof applyStateLog>;
      try {
        r = applyStateLog(copy, l);
      } catch {
        continue; // a log we can't decode changes nothing we model
      }
      if (r === null) continue;
      changed.add(key);
      this.overlay.set(key, { pool: copy, block: fb.block });
      if (r === "reread" || (copy.cl && !wordsNeeded(copy.cl.tick, copy.cl.tickSpacing).every((w) => copy.cl!.words.has(w)))) {
        // Liquidity (or the tick range we have loaded) changed: no exact maths until the confirmed read.
        this.unsettled.set(key, fb.block);
      }
    }
    if (!changed.size) return;
    this.counts.relevant++;
    this.rescore(changed);
  }

  /** Queue pools for a re-score; one runs at a time and the next picks up everything queued meanwhile. */
  private rescore(changed: Iterable<string>): void {
    for (const p of changed) this.queued.add(p);
    if (this.scanning) return;
    this.scanning = true;
    let done!: () => void;
    this.idle = new Promise<void>((r) => (done = r));
    void (async () => {
      try {
        while (this.queued.size && this.ctx) {
          const batch = new Set(this.queued);
          this.queued.clear();
          await this.scanOnce(batch, this.ctx);
        }
      } finally {
        this.scanning = false;
        done();
      }
    })();
  }

  private async scanOnce(changed: Set<string>, ctx: FlashblockContext): Promise<void> {
    const t0 = Date.now();
    try {
      const overlay = new Map<string, Pool>();
      for (const [a, e] of this.overlay) overlay.set(a, e.pool);
      const opps = await this.scanner.scan(ctx.block, ctx.gas, ctx.ethUsd, this.opts.minProfitUsd, {
        blockTag: PRECONF_TAG,
        stage: "flashblock",
        msIntoBlock: Date.now() - ctx.seenAt,
        changed,
        overlay,
        exclude: new Set(this.unsettled.keys()),
      });
      this.counts.scans++;
      this.scanRate.add();
      this.counts.opps += opps.length;
      if (opps.length) this.paper.register(opps);
      // Send the best eligible find now, a fraction of a second into the block instead of after it.
      if (opps.length && this.liveSend) this.liveSend(opps, ctx.ethUsd, "flashblock");
    } catch (err) {
      this.counts.errors++;
      if (this.counts.errors % 20 === 1) log.warn("flashblocks re-score failed:", (err as Error).message.slice(0, 140));
    } finally {
      const ms = Date.now() - t0;
      this.totalMs += ms;
      if (ms > this.counts.maxMs) this.counts.maxMs = ms;
    }
  }

  /**
   * Fallback while the stream is down: read the hot pools at the pending state into copies and
   * re-score routes through whichever of them changed.
   */
  private async poll(): Promise<void> {
    const ctx = this.ctx;
    if (this.polling || !ctx) return;
    const hot = [...this.hotPools()].map((a) => this.registry.pools.get(a)).filter((p): p is Pool => !!p && !p.v4);
    if (hot.length < 2) return;
    this.polling = true;
    try {
      this.counts.ticks++;
      const copies = hot.map((p) => clonePool(this.overlay.get(p.address)?.pool ?? p));
      const before = new Map(copies.map((p) => [p.address, poolStateSig(p)]));
      await this.registry.refreshReserves(copies, PRECONF_TAG, this.chain);
      if (!this.ctx || this.ctx.block !== ctx.block) return; // a block arrived meanwhile: re-read against it next time
      const changed = new Set<string>();
      for (const c of copies) {
        if (poolStateSig(c) === before.get(c.address)) continue;
        changed.add(c.address);
        this.overlay.set(c.address, { pool: c, block: ctx.block + 1 });
      }
      if (!changed.size) {
        this.counts.skippedUnchanged++;
        return;
      }
      this.rescore(changed);
    } catch (err) {
      this.counts.errors++;
      if (this.counts.errors % 20 === 1) log.warn("flashblocks poll failed:", (err as Error).message.slice(0, 140));
    } finally {
      this.polling = false;
    }
  }
}
