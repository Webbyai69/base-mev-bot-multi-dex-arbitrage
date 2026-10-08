/**
 * Paper-trading engine with honest outcome tracking.
 *
 * Finding an opportunity at block N is not the same as capturing it. On Base
 * a transaction sent when block N is seen lands in N+1 at best, so for every
 * opportunity we re-price the exact same route at N+1 and N+2 and look at
 * what the MEV classifier saw in those blocks:
 *
 *   persisted  the route was still profitable at the end of N+1 -> nobody
 *              took it, our transaction would very likely have succeeded.
 *              Realistic P&L uses the N+1 profit, not the N profit.
 *   taken      an arbitrage transaction touching our pools was mined in N+1
 *              (or N+2) by another searcher -> counted as lost.
 *   closed     the spread vanished (ordinary trades moved the price, or a bot
 *              we could not classify) -> counted as lost.
 */
import { quoteArb } from "./math.js";
import { evaluateRoute } from "./routes.js";
import type { Pool, PoolRegistry } from "./pools.js";
import { routeKey, poolsOf, type Opportunity } from "./scanner.js";
import type { DetectedMev } from "./classifier.js";
import { Store, dayKey } from "./store.js";
import { log } from "./log.js";
import { formatUnits } from "./math.js";

export const OPPS_FILE = "opportunities.jsonl";

export interface OpportunityRecord extends Opportunity {
  kind: "opportunity";
  mode: "paper" | "live";
}

export interface OutcomeRecord {
  kind: "outcome";
  id: string;
  block: number;
  finalizedAt: string;
  status: "persisted" | "taken" | "closed";
  profitAtN1Usd: number | null;
  profitAtN2Usd: number | null;
  /** Net of gas, what we would realistically have banked (persisted only). */
  realisticNetUsd: number;
  takenBy?: string;
  takenTx?: string;
  takenBlock?: number;
}

interface Pending {
  opp: Opportunity;
  checks: number;
  profitAtN1Usd: number | null;
  profitAtN2Usd: number | null;
  takenBy?: string;
  takenTx?: string;
  takenBlock?: number;
}


export class PaperEngine {
  private pending = new Map<string, Pending>();
  /**
   * Routes we have already "traded" on paper (a persisted outcome). One spread
   * is one trade: the same route is not counted again until it disappears for
   * at least one block, otherwise a spread that sits open for 20 blocks would
   * be booked 20 times.
   */
  private consumed = new Set<string>();

  constructor(readonly store: Store, readonly registry: PoolRegistry) {}

  /** Called once per block AFTER reserves are refreshed and the classifier has run. */
  onBlock(block: number, newOpps: Opportunity[], mevInBlock: DetectedMev[], ethUsd: number): void {
    // 1. Evaluate pending opportunities against this block's state. Blocks can
    //    be skipped when the RPC is slow, so we count evaluations, not ages.
    for (const [id, p] of this.pending) {
      const age = block - p.opp.block;
      if (age < 1) continue;
      const profitUsd = this.repriceUsd(p.opp, ethUsd);
      p.checks++;
      if (p.checks === 1) p.profitAtN1Usd = profitUsd;
      if (p.checks >= 2 || age >= 2) p.profitAtN2Usd = profitUsd;

      if (!p.takenBy) {
        const ours = poolsOf(p.opp);
        const taker = mevInBlock.find((m) => m.type === "arbitrage" && ours.some((x) => m.pools.includes(x)));
        if (taker) {
          p.takenBy = taker.bot;
          p.takenTx = taker.txHash;
          p.takenBlock = block;
        }
      }

      if (p.checks >= 2 || age >= 2 || p.takenBy) {
        this.finalize(id, p);
      }
    }

    // 2. Register new opportunities (one per route at a time; consumed routes
    //    stay muted until the spread has closed once).
    const routesNow = new Set(newOpps.map(routeKey));
    for (const r of [...this.consumed]) if (!routesNow.has(r)) this.consumed.delete(r);
    this.register(newOpps);
  }

  /**
   * Record new opportunities without evaluating pending ones. Used directly by
   * the Flashblocks loop: an opportunity found mid-block on pre-confirmed
   * state carries the last confirmed block number, so its first outcome check
   * happens on the very next confirmed block — exactly the block our
   * transaction would have landed in.
   */
  register(newOpps: Opportunity[]): void {
    const pendingRoutes = new Set([...this.pending.values()].map((p) => routeKey(p.opp)));
    for (const o of newOpps) {
      const r = routeKey(o);
      if (pendingRoutes.has(r) || this.consumed.has(r)) continue;
      pendingRoutes.add(r);
      const rec: OpportunityRecord = { ...o, kind: "opportunity", mode: "paper" };
      this.store.append(OPPS_FILE, rec);
      this.pending.set(o.id, { opp: o, checks: 0, profitAtN1Usd: null, profitAtN2Usd: null });
      const via = o.route ? `via ${o.route.dexes.join(">")}` : `buy ${o.buyDex} sell ${o.sellDex}`;
      log.info(
        `paper${o.stage === "flashblock" ? " [flashblock]" : ""}: ${o.pairSymbols} ${via} in=${formatUnits(o.amountIn, this.registry.token(o.tokenIn)?.decimals ?? 18, 5)} ${o.tokenInSymbol} ` +
          `profit=$${o.profitUsd.toFixed(3)} gas=$${o.gasUsd.toFixed(3)} net=$${o.netUsd.toFixed(3)} sim=${o.sim}`,
      );
    }
  }

  /** Same route, same input size, current reserves. Null when no longer profitable. */
  private repriceUsd(o: Opportunity, ethUsd: number): number | null {
    if (o.route) {
      const pools = o.route.pools.map((a) => this.registry.pools.get(a));
      if (pools.some((x) => !x)) return null;
      const q = evaluateRoute({ pools: pools as Pool[], tokens: o.route.tokens }, o.amountIn);
      if (!q || q.profit <= 0n) return null;
      return this.registry.usdValue(o.tokenIn, q.profit, ethUsd);
    }
    const buy = this.registry.pools.get(o.buyPool);
    const sell = this.registry.pools.get(o.sellPool);
    if (!buy || !sell) return null;
    const q = quoteArb(buy, sell, o.tokenIn, o.amountIn);
    if (!q || q.profit <= 0n) return null;
    return this.registry.usdValue(o.tokenIn, q.profit, ethUsd);
  }

  private finalize(id: string, p: Pending): void {
    let status: OutcomeRecord["status"];
    if (p.takenBy) status = "taken";
    else if (p.profitAtN1Usd !== null && p.profitAtN1Usd > 0) status = "persisted";
    else status = "closed";
    const realisticNetUsd = status === "persisted" ? Math.max(0, (p.profitAtN1Usd ?? 0) - p.opp.gasUsd) : 0;
    const rec: OutcomeRecord = {
      kind: "outcome",
      id,
      block: p.opp.block,
      finalizedAt: new Date().toISOString(),
      status,
      profitAtN1Usd: p.profitAtN1Usd,
      profitAtN2Usd: p.profitAtN2Usd,
      realisticNetUsd,
      takenBy: p.takenBy,
      takenTx: p.takenTx,
      takenBlock: p.takenBlock,
    };
    this.store.append(OPPS_FILE, rec);
    this.pending.delete(id);
    if (status === "persisted") this.consumed.add(routeKey(p.opp));
    const who = p.takenBy ? ` by ${p.takenBy.slice(0, 10)}` : "";
    log.info(`paper: ${p.opp.pairSymbols} @${p.opp.block} -> ${status}${who}; realistic net $${realisticNetUsd.toFixed(3)}`);
  }
}

// ---------------------------------------------------------------------------
// Summaries (used by the CLI and the daily report)
// ---------------------------------------------------------------------------

export interface DaySummary {
  day: string;
  found: number;
  optimisticNetUsd: number;
  realisticNetUsd: number;
  persisted: number;
  taken: number;
  closed: number;
  pending: number;
  gasUsd: number;
  byPair: Array<{ pair: string; count: number; netUsd: number }>;
  byRoute: Array<{ route: string; count: number; netUsd: number }>;
  takers: Array<{ bot: string; count: number }>;
  simMismatches: number;
  /** Results per strategy (classic V2, concentrated-liquidity, triangular) and per stage (block vs flashblock). */
  byKind: OutcomeStats[];
  byStage: OutcomeStats[];
  /** Win rate per route: how often a verified opportunity on this route was still there one block later. */
  scores: OutcomeStats[];
}

export interface OutcomeStats {
  key: string;
  found: number;
  persisted: number;
  taken: number;
  closed: number;
  /** persisted / (persisted + taken + closed); null until something finalized. */
  winRate: number | null;
  realisticNetUsd: number;
  optimisticNetUsd: number;
}

export function strategyKind(o: Pick<Opportunity, "route" | "hops">): string {
  if (!o.route) return "classic V2 two-pool";
  return (o.hops ?? o.route.pools.length) >= 3 ? "triangular / multi-hop" : "concentrated-liquidity two-pool";
}

function statsAgg(): Map<string, OutcomeStats> {
  return new Map();
}

function bump(m: Map<string, OutcomeStats>, key: string, o: OpportunityRecord, out: OutcomeRecord | undefined, verified: boolean): void {
  const e = m.get(key) ?? { key, found: 0, persisted: 0, taken: 0, closed: 0, winRate: null, realisticNetUsd: 0, optimisticNetUsd: 0 };
  e.found++;
  e.optimisticNetUsd += Number(o.netUsd);
  if (out) {
    e[out.status]++;
    if (verified) e.realisticNetUsd += out.realisticNetUsd;
  }
  const done = e.persisted + e.taken + e.closed;
  e.winRate = done ? e.persisted / done : null;
  m.set(key, e);
}

export async function summarize(store: Store, days?: string[]): Promise<DaySummary[]> {
  const opps = new Map<string, OpportunityRecord>();
  const outcomes = new Map<string, OutcomeRecord>();
  for await (const r of store.read<OpportunityRecord | OutcomeRecord>(OPPS_FILE)) {
    if (r.kind === "opportunity") opps.set(r.id, r);
    else if (r.kind === "outcome") outcomes.set(r.id, r);
  }
  const byDay = new Map<string, DaySummary>();
  const ensure = (day: string): DaySummary => {
    let s = byDay.get(day);
    if (!s) {
      s = { day, found: 0, optimisticNetUsd: 0, realisticNetUsd: 0, persisted: 0, taken: 0, closed: 0, pending: 0, gasUsd: 0, byPair: [], byRoute: [], takers: [], simMismatches: 0, byKind: [], byStage: [], scores: [] };
      byDay.set(day, s);
    }
    return s;
  };
  const pairAgg = new Map<string, Map<string, { count: number; netUsd: number }>>();
  const routeAgg = new Map<string, Map<string, { count: number; netUsd: number }>>();
  const takerAgg = new Map<string, Map<string, number>>();
  const kindAgg = new Map<string, Map<string, OutcomeStats>>();
  const stageAgg = new Map<string, Map<string, OutcomeStats>>();
  const scoreAgg = new Map<string, Map<string, OutcomeStats>>();
  const getAgg = (m: Map<string, Map<string, OutcomeStats>>, day: string) => {
    let x = m.get(day);
    if (!x) m.set(day, (x = statsAgg()));
    return x;
  };

  for (const o of opps.values()) {
    const day = dayKey(o.foundAt);
    if (days && !days.includes(day)) continue;
    const s = ensure(day);
    s.found++;
    s.optimisticNetUsd += Number(o.netUsd);
    s.gasUsd += Number(o.gasUsd);
    if (o.sim === "quoter-mismatch" || o.sim === "executor-revert") s.simMismatches++;
    const out = outcomes.get(o.id);
    const verified = o.sim === "executor-ok" || o.sim === "quoter-ok";
    if (!out) s.pending++;
    else {
      s[out.status]++;
      if (verified) s.realisticNetUsd += out.realisticNetUsd;
      if (out.takenBy) {
        const m = takerAgg.get(day) ?? new Map();
        m.set(out.takenBy, (m.get(out.takenBy) ?? 0) + 1);
        takerAgg.set(day, m);
      }
    }
    const pm = pairAgg.get(day) ?? new Map();
    const pe = pm.get(o.pairSymbols) ?? { count: 0, netUsd: 0 };
    pe.count++;
    pe.netUsd += Number(o.netUsd);
    pm.set(o.pairSymbols, pe);
    pairAgg.set(day, pm);
    bump(getAgg(kindAgg, day), strategyKind(o), o, out, verified);
    bump(getAgg(stageAgg, day), o.stage ?? "block", o, out, verified);
    if (verified) bump(getAgg(scoreAgg, day), `${o.pairSymbols} [${o.route ? o.route.dexes.join(">") : `${o.buyDex}>${o.sellDex}`}]`, o, out, verified);
    const route = o.route ? o.route.dexes.join(" -> ") : `${o.buyDex} -> ${o.sellDex}`;
    const rm = routeAgg.get(day) ?? new Map();
    const re = rm.get(route) ?? { count: 0, netUsd: 0 };
    re.count++;
    re.netUsd += Number(o.netUsd);
    rm.set(route, re);
    routeAgg.set(day, rm);
  }
  for (const s of byDay.values()) {
    s.byPair = [...(pairAgg.get(s.day) ?? new Map()).entries()]
      .map(([pair, v]) => ({ pair, ...v }))
      .sort((a, b) => b.netUsd - a.netUsd)
      .slice(0, 15);
    s.byRoute = [...(routeAgg.get(s.day) ?? new Map()).entries()]
      .map(([route, v]) => ({ route, ...v }))
      .sort((a, b) => b.count - a.count);
    s.byKind = [...(kindAgg.get(s.day) ?? new Map()).values()].sort((a, b) => b.found - a.found);
    s.byStage = [...(stageAgg.get(s.day) ?? new Map()).values()].sort((a, b) => b.found - a.found);
    s.scores = [...(scoreAgg.get(s.day) ?? new Map()).values()]
      .filter((x) => x.persisted + x.taken + x.closed > 0)
      .sort((a, b) => b.realisticNetUsd - a.realisticNetUsd || b.found - a.found)
      .slice(0, 25);
    s.takers = [...(takerAgg.get(s.day) ?? new Map()).entries()]
      .map(([bot, count]) => ({ bot, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}
