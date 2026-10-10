/**
 * Time per block: how long the confirmed-block handler takes, and where the time goes.
 *
 * Base makes a block every 2 s, so a handler slower than 2 s falls behind and skips blocks
 * (target today: < 2 s). At Denim blocks come every 200 ms (target then: < 200 ms). The last
 * 30 blocks are kept for the dashboard's "Time per block" figure and the periodic log line.
 */

export interface BlockPhases {
  /** eth_getBlockByNumber + the shared eth_getLogs. */
  fetchMs: number;
  /** Applying the logs to the pools (+ the reads they couldn't settle, + the periodic full re-read). */
  refreshMs: number;
  /** Gas quote (an eth_call for the L1 fee every ~20 s). */
  gasMs: number;
  /** Comparing pool state, searching cycles and sizing the changed routes (CPU). */
  findMs: number;
  /** On-chain verification of the survivors. */
  verifyMs: number;
  /** Waiting for the MEV classifier (it runs alongside the scan). */
  waitMs: number;
  /** Everything else: paper bookkeeping, live send, watch-list additions, reports. */
  restMs: number;
}

interface Sample {
  block: number;
  at: number;
  ms: number;
  phases: BlockPhases;
  scored: number;
  unchanged: number;
  candidates: number;
  changedPools: number;
  full: boolean;
}

export interface SpeedSummary {
  samples: number;
  lastBlock: number;
  lastMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Of the last `samples` blocks: slower than 2 s (today's limit) and than 200 ms (Denim's). */
  over2s: number;
  over200ms: number;
  /** Average of each phase over the window. */
  phases: BlockPhases;
  /** Route checks (positive-spread routes, the funnel's count) per minute. */
  routeChecksPerMin: number;
  /** Routes sized (re-scored), and routes skipped because none of their pools changed, per minute. */
  scoredPerMin: number;
  unchangedPerMin: number;
  /** Pools whose state changed, per block on average. */
  changedPoolsPerBlock: number;
  /** Times the scan-loop watchdog gave up on a block handler. */
  stalls: number;
  targetMs: number;
  denimTargetMs: number;
}

const WINDOW = 30;
const PHASES: Array<keyof BlockPhases> = ["fetchMs", "refreshMs", "gasMs", "findMs", "verifyMs", "waitMs", "restMs"];

export class BlockTimer {
  private ring: Sample[] = [];
  /** Per-block route counts over the last minute, for the per-minute rates. */
  private minute: Array<{ at: number; scored: number; unchanged: number; candidates: number }> = [];
  stalls = 0;

  add(block: number, ms: number, phases: BlockPhases, work: { scored: number; unchanged: number; candidates: number; changedPools: number; full: boolean }, now = Date.now()): void {
    this.ring.push({ block, at: now, ms, phases, ...work });
    if (this.ring.length > WINDOW) this.ring.splice(0, this.ring.length - WINDOW);
    this.minute.push({ at: now, scored: work.scored, unchanged: work.unchanged, candidates: work.candidates });
    while (this.minute.length && this.minute[0]!.at < now - 60_000) this.minute.shift();
  }

  summary(now = Date.now()): SpeedSummary {
    const r = this.ring;
    const sorted = r.map((x) => x.ms).sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]! : 0);
    const phases = Object.fromEntries(PHASES.map((k) => [k, r.length ? Math.round(r.reduce((a, x) => a + x.phases[k], 0) / r.length) : 0])) as unknown as BlockPhases;
    while (this.minute.length && this.minute[0]!.at < now - 60_000) this.minute.shift();
    // Scale to a minute when the bot has run for less than one.
    const span = this.minute.length ? Math.max(10_000, now - this.minute[0]!.at) : 60_000;
    const perMin = (n: number) => Math.round((n * 60_000) / span);
    return {
      samples: r.length,
      lastBlock: r.length ? r[r.length - 1]!.block : 0,
      lastMs: r.length ? r[r.length - 1]!.ms : 0,
      p50Ms: q(0.5),
      p95Ms: q(0.95),
      maxMs: sorted.length ? sorted[sorted.length - 1]! : 0,
      over2s: r.filter((x) => x.ms > 2000).length,
      over200ms: r.filter((x) => x.ms > 200).length,
      phases,
      routeChecksPerMin: perMin(this.minute.reduce((a, x) => a + x.candidates, 0)),
      scoredPerMin: perMin(this.minute.reduce((a, x) => a + x.scored, 0)),
      unchangedPerMin: perMin(this.minute.reduce((a, x) => a + x.unchanged, 0)),
      changedPoolsPerBlock: r.length ? Math.round(r.reduce((a, x) => a + (x.full ? 0 : x.changedPools), 0) / Math.max(1, r.filter((x) => !x.full).length)) : 0,
      stalls: this.stalls,
      targetMs: 2000,
      denimTargetMs: 200,
    };
  }
}
