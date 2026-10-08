/**
 * The bot's memory: what it has learned from everything it sees, kept across
 * restarts in data/learned.json. Old evidence fades (half-life, 3 days by
 * default), so its beliefs keep moving with the market instead of freezing on
 * last week.
 *
 * It learns from:
 *   - on-chain test runs: simulation passed / reverted, per token, pool and route
 *   - paper outcomes one block later: still there / taken by a rival / closed
 *   - rival arbitrage in every block: which pools, which bot, what priority fee
 *   - its own live sends: landed / reverted / dropped, the gas and the bid
 *   - pool activity: which watched pools had any swap at all
 *
 * And uses it to decide (one place, so the dashboard can explain every choice):
 *   1. skipReason()  routes, tokens and pools that keep failing test runs are
 *                    skipped before simulation (saves RPC), with a re-test every
 *                    few hours in case things changed
 *   2. pLand()       the chance a send lands, from this route's own record,
 *                    shrunk toward what similar routes do while data is thin
 *   3. evaluate()    expected value of sending: P(land) x profit minus
 *                    P(fail) x the gas a failed attempt burns; live mode only
 *                    sends when it is positive
 *   4. bid           priority fee from what rival bots paid for similar profit,
 *                    raised after races we lost, lowered after wins, never more
 *                    than a set share of the expected profit
 *   5. pruneList()   pools with no swaps, no finds and no rival trades for days
 *   6. suggestions() setting changes the evidence supports, for you to apply
 *                    on the dashboard (see Tuning)
 *
 * Simple, explainable statistics on purpose: with hundreds of observations
 * rather than millions, counts with sensible priors beat a fitted model.
 */
import { WETH, USDC, TOKENS } from "./config.js";
import type { Opportunity } from "./scanner.js";
import type { DetectedMev } from "./classifier.js";
import type { Store } from "./store.js";
import { log } from "./log.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A count that halves every half-life. Stored as value-at-time. */
interface Dc {
  v: number;
  t: number;
}
const dc = (): Dc => ({ v: 0, t: 0 });

export interface LearnOptions {
  halfLifeMs: number;
  /** A skipped token / route / pool gets one test run through after this long. */
  retestMs: number;
  /** Pools with no swaps, finds or rival trades for this long are dropped. */
  pruneAfterMs: number;
  /** Failed attempt's gas, as a share of a landed trade's gas (reverts stop early). */
  revertGasShare: number;
  /** Never bid more than this many gwei of priority fee. */
  maxBidGwei: number;
}

export const DEFAULT_LEARN: LearnOptions = {
  halfLifeMs: 72 * HOUR,
  retestMs: 6 * HOUR,
  pruneAfterMs: 3 * DAY,
  revertGasShare: 0.6,
  maxBidGwei: 2,
};

interface Rel {
  ok: Dc;
  fail: Dc;
  sym?: string;
  lastFail?: string;
  lastTestAt?: number;
}

interface RouteRec {
  label: string;
  kind: "classic" | "route";
  tokens: string[];
  pools: string[];
  found: Dc;
  simOk: Dc;
  simFail: Dc;
  /** Paper outcomes of verified finds: a proxy for "a send would have landed". */
  persisted: Dc;
  taken: Dc;
  closed: Dc;
  takers: Record<string, number>;
  liveSent: number;
  liveOk: number;
  liveRevert: number;
  liveDropped: number;
  liveGasUsd: number;
  liveNetUsd: number;
  racesLost: number;
  /** Learned bid multiplier (raised after lost races, lowered after wins). */
  bidMult: number;
  lastFail?: string;
  lastTestAt?: number;
  lastSeen: number;
}

interface PoolRec {
  firstSeen: number;
  activity: number;
  candidate: number;
  rival: number;
}

interface Memory {
  v: 1;
  since: number;
  /** Last save; on the next start the time in between doesn't count toward pruning (the bot wasn't watching). */
  savedAt?: number;
  tokens: Record<string, Rel>;
  pools: Record<string, Rel>;
  routes: Record<string, RouteRec>;
  poolSeen: Record<string, PoolRec>;
  /** Recent rival priority fees (gwei) by profit bucket, newest last. */
  rivalFees: Record<string, number[]>;
  prunedTotal: number;
  counts: { sims: number; outcomes: number; rivalArbs: number; liveSends: number };
}

export interface Evaluation {
  /** Chance a send lands (0-1) and how many decided observations it rests on. */
  pLand: number;
  evidence: number;
  /** Expected value of sending, in USD, after the bid's extra cost. */
  evUsd: number;
  /** Priority fee to bid, in gwei, and how it was chosen. */
  bidGwei: number;
  bidWhy: string;
}

const PROFIT_BUCKETS: Array<[string, number]> = [
  ["<$0.50", 0.5],
  ["$0.50-2", 2],
  ["$2-10", 10],
  ["$10+", Infinity],
];
const bucketOf = (usd: number): string => PROFIT_BUCKETS.find(([, max]) => usd < max)![0];
const FEE_RING = 400;

/** Tokens that are never blamed for a failed test run: the failure is in the other token or the pool. */
const CORE = new Set(Object.values(TOKENS).map((t) => t.address.toLowerCase()));
CORE.add(WETH);
CORE.add(USDC);

export function routeKeyFor(o: Pick<Opportunity, "route" | "buyPool" | "sellPool" | "tokenIn">): string {
  return o.route ? `${o.route.pools.join(">")}-${o.tokenIn}` : `${o.buyPool}-${o.sellPool}-${o.tokenIn}`;
}
const tokensOf = (o: Pick<Opportunity, "route" | "tokenIn" | "tokenMid">): string[] => (o.route ? o.route.tokens.slice(0, -1) : [o.tokenIn, o.tokenMid]).map((t) => t.toLowerCase());
const poolsOfOpp = (o: Pick<Opportunity, "route" | "buyPool" | "sellPool">): string[] => (o.route ? o.route.pools : [o.buyPool, o.sellPool]).map((p) => p.toLowerCase());
const labelOf = (o: Opportunity): string => (o.route ? `${o.pairSymbols} [${o.route.dexes.join(">")}]` : `${o.pairSymbols} [${o.buyDex}>${o.sellDex}]`);

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!;
}

export class Learner {
  readonly opts: LearnOptions;
  private m: Memory;
  private dirty = false;
  /** routeKey -> latest live send / paper outcome, to tell a lost race from a stale quote. */
  private recentLive = new Map<string, { block: number; status: string; at: number }>();
  private recentOutcome = new Map<string, { block: number; status: string; at: number }>();
  /** The bot's own wallet and trading contract: their trades are ours, not a rival's. */
  private self = new Set<string>();

  constructor(
    private store: Store | null,
    opts: Partial<LearnOptions> = {},
    private symbolOf: (address: string) => string = (a) => a.slice(0, 8),
  ) {
    this.opts = { ...DEFAULT_LEARN, ...opts };
    this.m = this.fresh(Date.now());
  }

  private fresh(now: number): Memory {
    return { v: 1, since: now, tokens: {}, pools: {}, routes: {}, poolSeen: {}, rivalFees: {}, prunedTotal: 0, counts: { sims: 0, outcomes: 0, rivalArbs: 0, liveSends: 0 } };
  }

  // ------------------------------------------------------------- decayed counts

  private val(c: Dc, now: number): number {
    if (!c.v) return 0;
    return c.v * Math.pow(0.5, Math.max(0, now - c.t) / this.opts.halfLifeMs);
  }
  private add(c: Dc, x: number, now: number): void {
    c.v = this.val(c, now) + x;
    c.t = now;
  }

  // ------------------------------------------------------------------ persistence

  static FILE = "learned.json";

  /** Load data/learned.json, or learn from the existing data files the first time. */
  async load(now = Date.now()): Promise<"loaded" | "warm-start" | "fresh"> {
    if (!this.store) return "fresh";
    try {
      const saved = this.store.readJson<Memory>(Learner.FILE);
      if (saved && saved.v === 1) {
        this.m = { ...this.fresh(saved.since ?? now), ...saved };
        this.pauseClock(now - (saved.savedAt ?? now));
        return "loaded";
      }
    } catch (err) {
      log.warn("learned.json unreadable, starting over:", (err as Error).message.slice(0, 120));
    }
    const n = await this.warmStart();
    // Swaps were never watched before now, so every pool's quiet-time clock starts here.
    for (const p of Object.values(this.m.poolSeen)) p.firstSeen = now;
    return n ? "warm-start" : "fresh";
  }

  /** Time the bot was off doesn't count as a quiet pool: move the pruning clocks forward by it. */
  private pauseClock(gapMs: number): void {
    if (!(gapMs > 60_000)) return;
    for (const p of Object.values(this.m.poolSeen)) {
      p.firstSeen += gapMs;
      if (p.activity) p.activity += gapMs;
      if (p.candidate) p.candidate += gapMs;
      if (p.rival) p.rival += gapMs;
    }
  }

  /** Addresses whose trades are the bot's own (its wallet and its contract). */
  setSelf(addresses: Array<string | null | undefined>): void {
    for (const a of addresses) if (a) this.self.add(a.toLowerCase());
  }

  save(force = false): void {
    if (!this.store || (!this.dirty && !force)) return;
    this.compact(Date.now());
    this.m.savedAt = Date.now();
    try {
      this.store.writeJson(Learner.FILE, this.m);
      this.dirty = false;
    } catch (err) {
      log.warn("could not save learned.json:", (err as Error).message.slice(0, 120));
    }
  }

  /** Replay data/opportunities.jsonl and data/mev.jsonl so the first start isn't a blank slate. */
  async warmStart(): Promise<number> {
    if (!this.store) return 0;
    let n = 0;
    const opps = new Map<string, Opportunity & { foundAt: string }>();
    try {
      for await (const r of this.store.read<Record<string, unknown>>("opportunities.jsonl")) {
        if (r.kind === "opportunity") {
          const o = reviveOpp(r);
          if (!o) continue;
          opps.set(o.id, o);
          const at = Date.parse(o.foundAt) || Date.now();
          this.onFound(o, at);
          this.onSim(o, at);
          n++;
        } else if (r.kind === "outcome") {
          const o = opps.get(String(r.id));
          if (!o) continue;
          this.onOutcome(o, String(r.status), typeof r.takenBy === "string" ? r.takenBy : undefined, Date.parse(String(r.finalizedAt)) || Date.now());
        }
      }
      for await (const r of this.store.read<Record<string, unknown>>("mev.jsonl")) {
        if (r.kind !== "mev" || r.type !== "arbitrage") continue;
        this.onRivalArbs([r as unknown as DetectedMev], Date.parse(String(r.timestamp)) || Date.now());
        n++;
      }
      for await (const r of this.store.read<Record<string, unknown>>("live.jsonl")) {
        if (r.status === "pending") continue;
        const o = opps.get(String(r.id));
        if (o) this.onLive(o, String(r.status) as "success" | "reverted" | "dropped", 0, Number(r.priorityFeeGwei ?? 0), Date.parse(String(r.sentAt)) || Date.now());
      }
    } catch (err) {
      log.warn("learning from past data failed part-way:", (err as Error).message.slice(0, 120));
    }
    if (n) {
      this.m.since = Math.min(this.m.since, ...[...opps.values()].map((o) => Date.parse(o.foundAt) || Date.now()));
      this.dirty = true;
    }
    return n;
  }

  /** Keep the file small: forget what has faded to almost nothing. */
  private compact(now: number): void {
    const faded = (r: Rel) => this.val(r.ok, now) + this.val(r.fail, now) < 0.05;
    for (const [k, r] of Object.entries(this.m.tokens)) if (faded(r)) delete this.m.tokens[k];
    for (const [k, r] of Object.entries(this.m.pools)) if (faded(r)) delete this.m.pools[k];
    const routes = Object.entries(this.m.routes);
    for (const [k, r] of routes) if (now - r.lastSeen > 14 * DAY && !r.liveSent) delete this.m.routes[k];
    const left = Object.entries(this.m.routes);
    if (left.length > 4000) {
      left.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (const [k] of left.slice(0, left.length - 4000)) delete this.m.routes[k];
    }
  }

  // ------------------------------------------------------------------ observing

  private route(o: Opportunity, now: number): RouteRec {
    const key = routeKeyFor(o);
    let r = this.m.routes[key];
    if (!r) {
      r = this.m.routes[key] = {
        label: labelOf(o),
        kind: o.route ? "route" : "classic",
        tokens: tokensOf(o),
        pools: poolsOfOpp(o),
        found: dc(),
        simOk: dc(),
        simFail: dc(),
        persisted: dc(),
        taken: dc(),
        closed: dc(),
        takers: {},
        liveSent: 0,
        liveOk: 0,
        liveRevert: 0,
        liveDropped: 0,
        liveGasUsd: 0,
        liveNetUsd: 0,
        racesLost: 0,
        bidMult: 1,
        lastSeen: now,
      };
    }
    r.lastSeen = Math.max(r.lastSeen, now);
    return r;
  }

  private rel(map: Record<string, Rel>, key: string, sym?: string): Rel {
    let r = map[key];
    if (!r) r = map[key] = { ok: dc(), fail: dc() };
    if (sym && !r.sym) r.sym = sym;
    return r;
  }

  private seen(pool: string, now: number): PoolRec {
    let p = this.m.poolSeen[pool];
    if (!p) p = this.m.poolSeen[pool] = { firstSeen: now, activity: 0, candidate: 0, rival: 0 };
    return p;
  }

  /** A candidate made it past the price check (before simulation). */
  onFound(o: Opportunity, now = Date.now()): void {
    const r = this.route(o, now);
    this.add(r.found, 1, now);
    for (const p of r.pools) this.seen(p, now).candidate = now;
    this.dirty = true;
  }

  /**
   * The test run's verdict. A failure is blamed on the route, on its non-core
   * tokens, and on its pools when every token is core (WETH, USDC…).
   */
  onSim(o: Opportunity, now = Date.now()): void {
    const ok = o.sim === "executor-ok" || o.sim === "quoter-ok";
    const fail = o.sim === "executor-revert" || o.sim === "quoter-mismatch";
    if (!ok && !fail) return;
    const r = this.route(o, now);
    this.add(ok ? r.simOk : r.simFail, 1, now);
    r.lastTestAt = now;
    if (fail) r.lastFail = (o.simDetail ?? o.sim).slice(0, 120);
    const exotic = r.tokens.filter((t) => !CORE.has(t));
    const blame = exotic.length ? exotic.map((t) => [this.m.tokens, t] as const) : r.pools.map((p) => [this.m.pools, p] as const);
    for (const [map, key] of blame) {
      const rel = this.rel(map, key, map === this.m.tokens ? this.symbolOf(key) : undefined);
      this.add(ok ? rel.ok : rel.fail, 1, now);
      rel.lastTestAt = now;
      if (fail) rel.lastFail = r.lastFail;
    }
    this.m.counts.sims++;
    this.dirty = true;
  }

  /** Paper outcome one block later. Only verified finds teach P(land). */
  onOutcome(o: Opportunity, status: string, takenBy: string | undefined, now = Date.now()): void {
    const r = this.route(o, now);
    // Taken by our own live send: that's a live result (counted in onLive), not a rival's win.
    const ours = status === "taken" && !!takenBy && this.self.has(takenBy.toLowerCase());
    const verified = o.sim === "executor-ok" || o.sim === "quoter-ok";
    if (verified && !ours) {
      if (status === "persisted") this.add(r.persisted, 1, now);
      else if (status === "taken") this.add(r.taken, 1, now);
      else if (status === "closed") this.add(r.closed, 1, now);
    }
    if (status === "taken" && takenBy && !ours) r.takers[takenBy] = (r.takers[takenBy] ?? 0) + 1;
    const key = routeKeyFor(o);
    this.recentOutcome.set(key, { block: o.block, status: ours ? "ours" : status, at: now });
    const live = this.recentLive.get(key);
    if (live && Math.abs(live.block - o.block) <= 2 && now - live.at < 120_000) this.judgeRace(r, live.status, status);
    this.m.counts.outcomes++;
    this.dirty = true;
  }

  /** Rival arbitrage: their pools stay interesting, and their fees teach the market rate. */
  onRivalArbs(detected: DetectedMev[], now = Date.now()): void {
    for (const d of detected) {
      if (d.type !== "arbitrage") continue;
      // Our own trades would teach it to bid against itself.
      if (d.bot && this.self.has(String(d.bot).toLowerCase())) continue;
      for (const p of d.pools) this.seen(p.toLowerCase(), now).rival = now;
      if (typeof d.priorityGwei === "number" && d.priorityGwei >= 0) {
        const b = bucketOf(typeof d.profitUsd === "number" ? d.profitUsd : 0);
        const ring = (this.m.rivalFees[b] ??= []);
        ring.push(Math.round(d.priorityGwei * 1e6) / 1e6);
        if (ring.length > FEE_RING) ring.splice(0, ring.length - FEE_RING);
      }
      this.m.counts.rivalArbs++;
    }
    if (detected.length) this.dirty = true;
  }

  /** Swaps / syncs seen in a block, for the pruning clock. */
  onPoolActivity(addresses: Iterable<string>, now = Date.now()): void {
    for (const a of addresses) {
      const p = this.m.poolSeen[a.toLowerCase()];
      if (p) p.activity = now;
    }
  }

  /** Make sure every watched pool has a first-seen time (pruning waits a full period from it). */
  track(pools: Iterable<string>, now = Date.now()): void {
    for (const a of pools) this.seen(a.toLowerCase(), now);
  }

  /** Our own live result. */
  onLive(o: Opportunity, status: "success" | "reverted" | "dropped", gasUsd: number, bidGwei: number, now = Date.now()): void {
    const r = this.route(o, now);
    r.liveSent++;
    if (status === "success") {
      r.liveOk++;
      r.liveNetUsd += o.netUsd;
    } else if (status === "reverted") r.liveRevert++;
    else r.liveDropped++;
    r.liveGasUsd += gasUsd;
    const key = routeKeyFor(o);
    this.recentLive.set(key, { block: o.block, status, at: now });
    const out = this.recentOutcome.get(key);
    if (out && Math.abs(out.block - o.block) <= 2 && now - out.at < 120_000) this.judgeRace(r, status, out.status);
    else if (status === "success") r.bidMult = Math.max(0.5, r.bidMult * 0.9);
    this.m.counts.liveSends++;
    this.dirty = true;
    void bidGwei;
  }

  /** A revert when a rival took the same trade is a lost race: bid more next time. A win: a little less. */
  private judgeRace(r: RouteRec, live: string, outcome: string): void {
    if (live === "reverted" && outcome === "taken") {
      r.racesLost++;
      r.bidMult = Math.min(8, r.bidMult * 1.5);
    } else if (live === "success") {
      r.bidMult = Math.max(0.5, r.bidMult * 0.9);
    }
  }

  // ------------------------------------------------------------------- deciding

  private pFail(rel: { ok: Dc; fail: Dc }, now: number): { p: number; n: number } {
    const ok = this.val(rel.ok, now);
    const fail = this.val(rel.fail, now);
    return { p: (fail + 1) / (ok + fail + 2), n: ok + fail };
  }

  /**
   * Why to skip this candidate before simulating it, or null. A skipped item
   * still gets one test run through every `retestMs`, so a token that was
   * broken for an afternoon isn't banned forever.
   */
  skipReason(o: Opportunity, now = Date.now(), blocked: Set<string> = new Set()): string | null {
    for (const t of tokensOf(o)) if (blocked.has(t)) return `${this.symbolOf(t)} is blocked`;
    const r = this.m.routes[routeKeyFor(o)];
    if (r) {
      const f = this.pFail({ ok: r.simOk, fail: r.simFail }, now);
      if (f.n >= 3 && f.p >= 0.75 && now - (r.lastTestAt ?? 0) < this.opts.retestMs) return `route failed ${Math.round(f.p * 100)}% of ${f.n.toFixed(0)} test runs`;
    }
    for (const t of tokensOf(o)) {
      if (CORE.has(t)) continue;
      const rel = this.m.tokens[t];
      if (!rel) continue;
      const f = this.pFail(rel, now);
      if (f.n >= 4 && f.p >= 0.8 && now - (rel.lastTestAt ?? 0) < this.opts.retestMs) return `${rel.sym ?? this.symbolOf(t)} failed ${Math.round(f.p * 100)}% of ${f.n.toFixed(0)} test runs`;
    }
    for (const p of poolsOfOpp(o)) {
      const rel = this.m.pools[p];
      if (!rel) continue;
      const f = this.pFail(rel, now);
      if (f.n >= 4 && f.p >= 0.85 && now - (rel.lastTestAt ?? 0) < this.opts.retestMs) return `pool ${p.slice(0, 10)} failed ${Math.round(f.p * 100)}% of test runs`;
    }
    return null;
  }

  /** Overall rate at which verified finds were still there a block later (the prior for new routes). */
  private globalLandRate(kind: "classic" | "route", now: number): number {
    let won = 0;
    let decided = 0;
    for (const r of Object.values(this.m.routes)) {
      if (r.kind !== kind) continue;
      won += this.val(r.persisted, now) + 3 * r.liveOk;
      decided += this.val(r.persisted, now) + this.val(r.taken, now) + this.val(r.closed, now) + 3 * r.liveSent;
    }
    // With no evidence at all, assume a coin flip.
    return decided >= 3 ? won / decided : 0.5;
  }

  /** P(land) for this route: its own paper and live record (live counts 3x), shrunk toward similar routes. */
  pLand(o: Opportunity, now = Date.now()): { p: number; evidence: number } {
    const r = this.m.routes[routeKeyFor(o)];
    const kind = o.route ? "route" : "classic";
    const prior = this.globalLandRate(kind, now);
    const strength = 2;
    if (!r) return { p: prior, evidence: 0 };
    const won = this.val(r.persisted, now) + 3 * r.liveOk;
    const decided = this.val(r.persisted, now) + this.val(r.taken, now) + this.val(r.closed, now) + 3 * r.liveSent;
    return { p: (prior * strength + won) / (strength + decided), evidence: decided };
  }

  /** What rival bots paid for trades of this size (gwei): the 60th percentile, or null with too little data. */
  marketBid(profitUsd: number): { gwei: number | null; samples: number } {
    const own = this.m.rivalFees[bucketOf(profitUsd)] ?? [];
    if (own.length >= 20) return { gwei: quantile(own, 0.6), samples: own.length };
    const all = Object.values(this.m.rivalFees).flat();
    return { gwei: all.length >= 20 ? quantile(all, 0.6) : null, samples: all.length };
  }

  /**
   * Should a live send go out, and with what bid? `gasUnits` is what a landed
   * trade uses; `basePriorityGwei` is PRIORITY_FEE_GWEI, already inside gasUsd.
   */
  evaluate(o: Opportunity, ctx: { ethUsd: number; gasUnits: number; basePriorityGwei: number; maxBidShare: number }, now = Date.now()): Evaluation {
    const { p, evidence } = this.pLand(o, now);
    const r = this.m.routes[routeKeyFor(o)];
    const mult = r?.bidMult ?? 1;
    const market = this.marketBid(o.profitUsd);
    let bid = ctx.basePriorityGwei;
    let why = `base ${ctx.basePriorityGwei} gwei`;
    if (market.gwei !== null) {
      const want = market.gwei * mult;
      if (want > bid) {
        bid = want;
        why = `rivals' p60 ${market.gwei.toFixed(4)} gwei for ${bucketOf(o.profitUsd)} trades${mult !== 1 ? ` x ${mult.toFixed(2)} (this route's record)` : ""}`;
      }
    } else if (mult > 1) {
      bid = ctx.basePriorityGwei * mult;
      why = `base x ${mult.toFixed(2)} after lost races`;
    }
    const usdPerGwei = (ctx.gasUnits * 1e9 * ctx.ethUsd) / 1e18; // cost of 1 gwei of tip over the whole trade
    // The extra tip never costs more than maxBidShare of the profit left after gas.
    const capByShare = usdPerGwei > 0 ? ctx.basePriorityGwei + (ctx.maxBidShare * Math.max(0, o.netUsd)) / usdPerGwei : bid;
    const cap = Math.min(this.opts.maxBidGwei, capByShare);
    if (bid > cap) {
      bid = Math.max(ctx.basePriorityGwei, cap);
      why += `, capped at ${Math.round(ctx.maxBidShare * 100)}% of the profit`;
    }
    const extraUsd = Math.max(0, bid - ctx.basePriorityGwei) * usdPerGwei;
    const landedNet = o.netUsd - extraUsd;
    const failCost = this.opts.revertGasShare * o.gasUsd + this.opts.revertGasShare * extraUsd;
    const evUsd = p * landedNet - (1 - p) * failCost;
    return { pLand: p, evidence, evUsd, bidGwei: Math.round(bid * 1e6) / 1e6, bidWhy: why };
  }

  /**
   * Watched pools to stop watching: nothing happened in them (no swap, no find,
   * no rival trade) for `pruneAfterMs`, or every test run through them failed.
   * Pools whose two tokens are both core (WETH, USDC…) are kept for pricing.
   */
  pruneList(watched: Array<{ address: string; token0: string; token1: string }>, now = Date.now()): string[] {
    const out: string[] = [];
    for (const p of watched) {
      const a = p.address.toLowerCase();
      if (CORE.has(p.token0.toLowerCase()) && CORE.has(p.token1.toLowerCase())) continue;
      const s = this.m.poolSeen[a];
      if (s) {
        const last = Math.max(s.firstSeen, s.activity, s.candidate, s.rival);
        if (now - last >= this.opts.pruneAfterMs) {
          out.push(a);
          continue;
        }
      }
      const rel = this.m.pools[a];
      if (rel) {
        const f = this.pFail(rel, now);
        if (f.n >= 6 && f.p >= 0.9) out.push(a);
      }
    }
    return out;
  }

  notePruned(addresses: string[]): void {
    this.m.prunedTotal += addresses.length;
    for (const a of addresses) delete this.m.poolSeen[a];
    this.dirty = true;
  }

  /** Tokens that have failed nearly every test run, with enough evidence to block for good. */
  badTokens(now = Date.now(), minN = 10, minP = 0.9): Array<{ token: string; sym: string; p: number; n: number; why: string }> {
    const out: Array<{ token: string; sym: string; p: number; n: number; why: string }> = [];
    for (const [t, rel] of Object.entries(this.m.tokens)) {
      const f = this.pFail(rel, now);
      if (f.n >= minN && f.p >= minP) out.push({ token: t, sym: rel.sym ?? this.symbolOf(t), p: f.p, n: f.n, why: rel.lastFail ?? "" });
    }
    return out.sort((a, b) => b.n - a.n);
  }

  /** Live record over the last `windowMs`, for suggestions. */
  liveRecord(): { sent: number; ok: number; reverted: number; racesLost: number; gasUsd: number } {
    let sent = 0;
    let ok = 0;
    let reverted = 0;
    let racesLost = 0;
    let gasUsd = 0;
    for (const r of Object.values(this.m.routes)) {
      sent += r.liveSent;
      ok += r.liveOk;
      reverted += r.liveRevert;
      racesLost += r.racesLost;
      gasUsd += r.liveGasUsd;
    }
    return { sent, ok, reverted, racesLost, gasUsd };
  }

  // ---------------------------------------------------------------- explaining

  /** Compact view for the dashboard and the online copy. */
  summary(now = Date.now(), blocked: Set<string> = new Set()): LearningSummary {
    const routes = Object.entries(this.m.routes);
    const skipping = this.badTokens(now, 4, 0.8).slice(0, 8).map((t) => ({ ...t, p: round(t.p, 2), n: round(t.n, 1), blocked: blocked.has(t.token) }));
    const routeRows = routes
      .map(([key, r]) => {
        const decided = this.val(r.persisted, now) + this.val(r.taken, now) + this.val(r.closed, now);
        const sim = this.pFail({ ok: r.simOk, fail: r.simFail }, now);
        const top = Object.entries(r.takers).sort((a, b) => b[1] - a[1])[0];
        return {
          key,
          label: r.label,
          kind: r.kind,
          found: round(this.val(r.found, now), 1),
          testFail: sim.n ? round(sim.p, 2) : null,
          tests: round(sim.n, 1),
          stillThere: decided ? round(this.val(r.persisted, now) / decided, 2) : null,
          takenShare: decided ? round(this.val(r.taken, now) / decided, 2) : null,
          topRival: top ? top[0] : null,
          live: r.liveSent ? { sent: r.liveSent, ok: r.liveOk, reverted: r.liveRevert, racesLost: r.racesLost } : null,
          bidMult: round(r.bidMult, 2),
          lastSeen: new Date(r.lastSeen).toISOString(),
        };
      })
      .sort((a, b) => b.found - a.found)
      .slice(0, 12);
    const fees: LearningSummary["bids"] = PROFIT_BUCKETS.map(([b]) => {
      const ring = this.m.rivalFees[b] ?? [];
      return { bucket: b, samples: ring.length, p50: round(quantile(ring, 0.5), 5), p60: round(quantile(ring, 0.6), 5), p90: round(quantile(ring, 0.9), 5) };
    });
    const live = this.liveRecord();
    const watchedSeen = Object.values(this.m.poolSeen);
    return {
      since: new Date(this.m.since).toISOString(),
      halfLifeHours: Math.round(this.opts.halfLifeMs / HOUR),
      counts: { ...this.m.counts, routes: routes.length, tokens: Object.keys(this.m.tokens).length },
      skipping,
      routes: routeRows,
      landRate: { classic: round(this.globalLandRate("classic", now), 2), route: round(this.globalLandRate("route", now), 2) },
      bids: fees,
      live: { ...live, gasUsd: round(live.gasUsd, 4) },
      pools: { tracked: watchedSeen.length, quiet: watchedSeen.filter((p) => now - Math.max(p.firstSeen, p.activity, p.candidate, p.rival) >= DAY).length, prunedTotal: this.m.prunedTotal, pruneAfterDays: round(this.opts.pruneAfterMs / DAY, 1) },
    };
  }
}

export interface LearningSummary {
  since: string;
  halfLifeHours: number;
  counts: { sims: number; outcomes: number; rivalArbs: number; liveSends: number; routes: number; tokens: number };
  skipping: Array<{ token: string; sym: string; p: number; n: number; why: string; blocked: boolean }>;
  routes: Array<{
    key: string;
    label: string;
    kind: "classic" | "route";
    found: number;
    testFail: number | null;
    tests: number;
    stillThere: number | null;
    takenShare: number | null;
    topRival: string | null;
    live: { sent: number; ok: number; reverted: number; racesLost: number } | null;
    bidMult: number;
    lastSeen: string;
  }>;
  landRate: { classic: number; route: number };
  bids: Array<{ bucket: string; samples: number; p50: number | null; p60: number | null; p90: number | null }>;
  live: { sent: number; ok: number; reverted: number; racesLost: number; gasUsd: number };
  pools: { tracked: number; quiet: number; prunedTotal: number; pruneAfterDays: number };
}

function round<T extends number | null>(x: T, dp: number): T {
  if (x === null) return x;
  const f = Math.pow(10, dp);
  return (Math.round((x as number) * f) / f) as T;
}

/** An opportunity record from opportunities.jsonl back into the shape the learner reads. */
function reviveOpp(r: Record<string, unknown>): (Opportunity & { foundAt: string }) | null {
  if (typeof r.id !== "string" || typeof r.buyPool !== "string" || typeof r.sellPool !== "string" || typeof r.tokenIn !== "string") return null;
  const big = (x: unknown) => {
    try {
      return BigInt(String(x ?? 0));
    } catch {
      return 0n;
    }
  };
  const route = r.route && typeof r.route === "object" ? (r.route as Opportunity["route"]) : undefined;
  return {
    ...(r as unknown as Opportunity),
    foundAt: String(r.foundAt ?? new Date().toISOString()),
    amountIn: big(r.amountIn),
    amountMid: big(r.amountMid),
    amountOut: big(r.amountOut),
    profit: big(r.profit),
    profitUsd: Number(r.profitUsd ?? 0),
    gasUsd: Number(r.gasUsd ?? 0),
    netUsd: Number(r.netUsd ?? 0),
    tokenMid: String(r.tokenMid ?? ""),
    ...(route ? { route } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tuning: setting changes you approve on the dashboard, kept in data/tuning.json
// ---------------------------------------------------------------------------

/**
 * What the dashboard may change, and within what limits. Everything that
 * decides whether real money moves at all (MODE, MAX_DAILY_GAS_USD,
 * MAX_CONSECUTIVE_FAILURES, EXECUTOR_ADDRESS, keys) is deliberately not here:
 * those stay in .env, which only you edit.
 */
export const TUNABLE = {
  minProfitUsd: { min: 0.05, max: 5, label: "Minimum profit per trade (USD, after gas)" },
  maxBidShare: { min: 0, max: 0.5, label: "Most of the expected profit it may bid as priority fee" },
  evMinUsd: { min: 0, max: 1, label: "Smallest expected value (USD) worth a live send" },
} as const;
export type TunableKey = keyof typeof TUNABLE;

export interface Suggestion {
  id: string;
  /** A tunable setting, or "blockToken" (value = token address). */
  key: TunableKey | "blockToken";
  value: number | string;
  current: number | string | null;
  title: string;
  why: string;
  source: "bot" | "ai-review";
}

interface TuningFile {
  v: 1;
  values: Partial<Record<TunableKey, number>>;
  blockedTokens: Record<string, { sym: string; at: string; why: string }>;
  applied: Array<{ key: string; value: number | string; at: string; source: string; title: string }>;
  dismissed: Record<string, string>;
}

export class Tuning {
  static FILE = "tuning.json";
  private t: TuningFile = { v: 1, values: {}, blockedTokens: {}, applied: [], dismissed: {} };
  suggestions: Suggestion[] = [];

  constructor(
    private store: Store | null,
    private base: { minProfitUsd: number; maxBidShare: number; evMinUsd: number },
  ) {
    try {
      const saved = store?.readJson<TuningFile>(Tuning.FILE);
      if (saved && saved.v === 1) this.t = { ...this.t, ...saved };
    } catch (err) {
      log.warn("tuning.json unreadable, ignoring it:", (err as Error).message.slice(0, 120));
    }
    // Re-check the bounds on load: a hand-edited file can't push a value past them.
    for (const k of Object.keys(this.t.values) as TunableKey[]) {
      const v = this.t.values[k];
      if (!(k in TUNABLE) || typeof v !== "number" || !Number.isFinite(v) || v < TUNABLE[k].min || v > TUNABLE[k].max) delete this.t.values[k];
    }
  }

  get minProfitUsd(): number {
    return this.t.values.minProfitUsd ?? this.base.minProfitUsd;
  }
  get maxBidShare(): number {
    return this.t.values.maxBidShare ?? this.base.maxBidShare;
  }
  get evMinUsd(): number {
    return this.t.values.evMinUsd ?? this.base.evMinUsd;
  }
  get blocked(): Set<string> {
    return new Set(Object.keys(this.t.blockedTokens));
  }

  private save(): void {
    try {
      this.store?.writeJson(Tuning.FILE, this.t);
    } catch (err) {
      log.warn("could not save tuning.json:", (err as Error).message.slice(0, 120));
    }
  }

  /** Work out what the evidence supports changing. Dismissed suggestions stay hidden for a week. */
  refresh(learner: Learner, aiReviewText: string | null, now = Date.now()): Suggestion[] {
    const out: Suggestion[] = [];
    for (const t of learner.badTokens(now)) {
      if (this.t.blockedTokens[t.token]) continue;
      out.push({
        id: `block:${t.token}`,
        key: "blockToken",
        value: t.token,
        current: null,
        title: `Block ${t.sym}`,
        why: `Failed ${Math.round(t.p * 100)}% of ${Math.round(t.n)} recent test runs${t.why ? ` (last: ${t.why.slice(0, 80)})` : ""}. Blocking it stops the re-tests and drops its pools.`,
        source: "bot",
      });
    }
    const live = learner.liveRecord();
    if (live.sent >= 5 && live.ok / live.sent < 0.2) {
      const next = Math.min(TUNABLE.minProfitUsd.max, Math.round(this.minProfitUsd * 2 * 100) / 100);
      if (next > this.minProfitUsd)
        out.push({
          id: `minProfit:${next}`,
          key: "minProfitUsd",
          value: next,
          current: this.minProfitUsd,
          title: `Raise the minimum profit to $${next}`,
          why: `Only ${live.ok} of ${live.sent} live sends landed. Bigger gaps survive longer, so fewer attempts fail and burn gas.`,
          source: "bot",
        });
    }
    if (live.racesLost >= 3 && this.maxBidShare < TUNABLE.maxBidShare.max) {
      const next = Math.min(TUNABLE.maxBidShare.max, Math.round((this.maxBidShare + 0.1) * 100) / 100);
      out.push({
        id: `bidShare:${next}`,
        key: "maxBidShare",
        value: next,
        current: this.maxBidShare,
        title: `Let it bid up to ${Math.round(next * 100)}% of the profit`,
        why: `It lost ${live.racesLost} races to bots that paid a higher priority fee. A higher cap lets it compete on the trades worth it.`,
        source: "bot",
      });
    }
    out.push(...parseReviewSuggestions(aiReviewText, this));
    const week = 7 * DAY;
    this.suggestions = out.filter((s) => !(this.t.dismissed[s.id] && now - Date.parse(this.t.dismissed[s.id]!) < week));
    return this.suggestions;
  }

  /** Apply, dismiss or reset. Values are re-checked against the limits here, whatever the caller sent. */
  act(action: string, id: string | undefined, now = new Date()): { ok: boolean; error?: string; blockedToken?: string } {
    if (action === "reset") {
      this.t.values = {};
      this.t.blockedTokens = {};
      this.t.applied.push({ key: "reset", value: "", at: now.toISOString(), source: "you", title: "Back to the .env settings" });
      this.save();
      return { ok: true };
    }
    const s = this.suggestions.find((x) => x.id === id);
    if (!s) return { ok: false, error: "That suggestion is no longer current. Reload the page." };
    if (action === "dismiss") {
      this.t.dismissed[s.id] = now.toISOString();
      this.suggestions = this.suggestions.filter((x) => x.id !== s.id);
      this.save();
      return { ok: true };
    }
    if (action !== "apply") return { ok: false, error: "unknown action" };
    if (s.key === "blockToken") {
      const token = String(s.value).toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(token)) return { ok: false, error: "not a token address" };
      this.t.blockedTokens[token] = { sym: s.title.replace(/^Block /, ""), at: now.toISOString(), why: s.why };
    } else {
      const lim = TUNABLE[s.key];
      const v = Number(s.value);
      if (!lim || !Number.isFinite(v) || v < lim.min || v > lim.max) return { ok: false, error: "value outside the allowed range" };
      this.t.values[s.key] = v;
    }
    this.t.applied.push({ key: s.key, value: s.value, at: now.toISOString(), source: s.source, title: s.title });
    if (this.t.applied.length > 50) this.t.applied.splice(0, this.t.applied.length - 50);
    this.suggestions = this.suggestions.filter((x) => x.id !== s.id);
    this.save();
    return { ok: true, ...(s.key === "blockToken" ? { blockedToken: String(s.value).toLowerCase() } : {}) };
  }

  view(): TuningView {
    return {
      effective: { minProfitUsd: this.minProfitUsd, maxBidShare: this.maxBidShare, evMinUsd: this.evMinUsd },
      fromEnv: { ...this.base },
      overrides: { ...this.t.values },
      blockedTokens: Object.entries(this.t.blockedTokens).map(([token, b]) => ({ token, ...b })),
      applied: this.t.applied.slice(-8).reverse(),
      suggestions: this.suggestions,
      limits: TUNABLE,
    };
  }
}

export interface TuningView {
  effective: { minProfitUsd: number; maxBidShare: number; evMinUsd: number };
  fromEnv: { minProfitUsd: number; maxBidShare: number; evMinUsd: number };
  overrides: Partial<Record<TunableKey, number>>;
  blockedTokens: Array<{ token: string; sym: string; at: string; why: string }>;
  applied: TuningFile["applied"];
  suggestions: Suggestion[];
  limits: typeof TUNABLE;
}

/**
 * The daily AI review may end with a fenced ```json block:
 *   {"suggestions": [{"key": "minProfitUsd", "value": 0.4, "why": "…"}]}
 * Only known keys within their limits get through; anything else is ignored.
 */
export function parseReviewSuggestions(text: string | null, tuning: Tuning): Suggestion[] {
  if (!text) return [];
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]!);
  } catch {
    return [];
  }
  const list = (parsed as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) return [];
  const out: Suggestion[] = [];
  for (const x of list.slice(0, 10)) {
    const key = (x as { key?: unknown }).key;
    const value = Number((x as { value?: unknown }).value);
    const why = String((x as { why?: unknown }).why ?? "").slice(0, 300);
    if (typeof key !== "string" || !(key in TUNABLE) || !Number.isFinite(value)) continue;
    const lim = TUNABLE[key as TunableKey];
    if (value < lim.min || value > lim.max) continue;
    const current = (tuning as unknown as { [k: string]: number })[key] ?? null;
    if (current === value) continue;
    out.push({ id: `review:${key}:${value}`, key: key as TunableKey, value, current, title: `${lim.label}: ${value}`, why: why || "Suggested by the daily AI review.", source: "ai-review" });
  }
  return out;
}
