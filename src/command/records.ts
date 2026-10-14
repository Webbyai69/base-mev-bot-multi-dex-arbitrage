/**
 * In-memory copies of the bot's records for the command center.
 *
 * The API runs inside the trading process, so it must never re-read big
 * files on every request (that would stall the block loop). The first
 * request reads a bounded tail of each file once; after that new records
 * stream in through Store.onAppend. Buffers are capped, so memory stays
 * bounded however long the bot runs.
 */
import type { Store } from "../store.js";
import type { LiveLite, MevLite, OppLite, OutcomeLite } from "./telemetry.js";

const CAP = { opps: 20_000, outcomes: 20_000, mev: 60_000, lives: 5_000 } as const;
const TAIL = { opps: 6 * 1024 * 1024, mev: 6 * 1024 * 1024, live: 1024 * 1024 } as const;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown, max = 120): string => (typeof v === "string" ? v.slice(0, max) : v === undefined || v === null ? "" : String(v).slice(0, max));
const strs = (v: unknown, n = 8): string[] => (Array.isArray(v) ? v.slice(0, n).map((x) => str(x, 60)) : []);

export function toOpp(r: Record<string, unknown>): OppLite | undefined {
  if (r.kind !== "opportunity" || r.id === undefined) return undefined;
  const route = r.route as { dexes?: unknown; pools?: unknown[] } | undefined;
  const dexes = route ? strs(route.dexes) : [];
  const o: OppLite = {
    id: str(r.id),
    block: num(r.block),
    foundAt: str(r.foundAt, 40),
    pairSymbols: str(r.pairSymbols, 60) || "?",
    buyDex: str(r.buyDex, 40) || dexes[0] || "?",
    sellDex: str(r.sellDex, 40) || dexes.at(-1) || "?",
    netUsd: num(r.netUsd),
    profitUsd: num(r.profitUsd),
    gasUsd: num(r.gasUsd),
    stage: r.stage === "flashblock" ? "flashblock" : "block",
    hops: num(r.hops ?? route?.pools?.length ?? 2) || 2,
  };
  if (dexes.length) o.dexes = dexes;
  if (typeof r.msIntoBlock === "number" && Number.isFinite(r.msIntoBlock)) o.msIntoBlock = r.msIntoBlock;
  return o;
}

export function toOutcome(r: Record<string, unknown>): OutcomeLite | undefined {
  if (r.kind !== "outcome" || r.id === undefined) return undefined;
  const status = r.status === "persisted" || r.status === "taken" || r.status === "closed" ? r.status : undefined;
  if (!status) return undefined;
  const o: OutcomeLite = { id: str(r.id), block: num(r.block), status, realisticNetUsd: num(r.realisticNetUsd) };
  if (typeof r.takenBy === "string") o.takenBy = r.takenBy.slice(0, 60);
  if (typeof r.takenBlock === "number") o.takenBlock = r.takenBlock;
  return o;
}

export function toMev(r: Record<string, unknown>): MevLite | undefined {
  if (r.kind !== "mev" || (r.type !== "arbitrage" && r.type !== "sandwich")) return undefined;
  const m: MevLite = {
    block: num(r.block),
    timestamp: str(r.timestamp, 40),
    txIndex: num(r.txIndex),
    bot: str(r.bot, 60).toLowerCase(),
    sender: str(r.sender, 60).toLowerCase(),
    dexes: strs(r.dexes),
    tokens: strs(r.tokens, 6),
    profitUsd: typeof r.profitUsd === "number" && Number.isFinite(r.profitUsd) ? r.profitUsd : null,
    type: r.type,
  };
  if (typeof r.costUsd === "number") m.costUsd = r.costUsd;
  if (typeof r.priorityGwei === "number") m.priorityGwei = r.priorityGwei;
  return m;
}

export function toLive(r: Record<string, unknown>): LiveLite | undefined {
  if (r.id === undefined || typeof r.sentAt !== "string") return undefined;
  const status = r.status === "pending" || r.status === "success" || r.status === "reverted" || r.status === "dropped" ? r.status : undefined;
  if (!status) return undefined;
  const l: LiveLite = {
    id: str(r.id),
    block: num(r.block),
    sentAt: r.sentAt.slice(0, 40),
    status,
    priorityFeeGwei: num(r.priorityFeeGwei),
    expectedProfitUsd: num(r.expectedProfitUsd),
  };
  if (typeof r.gasUsd === "number") l.gasUsd = r.gasUsd;
  if (typeof r.minedBlock === "number") l.minedBlock = r.minedBlock;
  return l;
}

export class Records {
  opps: OppLite[] = [];
  outcomes: OutcomeLite[] = [];
  mev: MevLite[] = [];
  lives: LiveLite[] = [];
  /** Bumped on every record, so cached results know when they are stale. */
  version = 0;
  private loaded = false;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly store: Store) {}

  /** Read the file tails once (lazily, on the first request), then follow appends. */
  ensure(): this {
    if (this.loaded) return this;
    this.loaded = true;
    for (const r of this.store.tail<Record<string, unknown>>("opportunities.jsonl", TAIL.opps)) this.ingest("opportunities.jsonl", r);
    for (const r of this.store.tail<Record<string, unknown>>("mev.jsonl", TAIL.mev)) this.ingest("mev.jsonl", r);
    for (const r of this.store.tail<Record<string, unknown>>("live.jsonl", TAIL.live)) this.ingest("live.jsonl", r);
    // Synchronous reads above, so nothing was appended between the tail and the subscription.
    this.unsubscribe = this.store.onAppend((file, rec) => this.ingest(file, rec));
    return this;
  }

  ingest(file: string, rec: unknown): void {
    if (!rec || typeof rec !== "object") return;
    const r = rec as Record<string, unknown>;
    if (file === "opportunities.jsonl") {
      const o = toOpp(r);
      if (o) push(this.opps, o, CAP.opps);
      else {
        const oc = toOutcome(r);
        if (oc) push(this.outcomes, oc, CAP.outcomes);
      }
    } else if (file === "mev.jsonl") {
      const m = toMev(r);
      if (m) push(this.mev, m, CAP.mev);
    } else if (file === "live.jsonl") {
      const l = toLive(r);
      if (l) push(this.lives, l, CAP.lives);
    } else return;
    this.version++;
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

function push<T>(arr: T[], v: T, cap: number): void {
  arr.push(v);
  // Trim in batches so the splice cost is paid rarely.
  if (arr.length > cap * 1.1) arr.splice(0, arr.length - cap);
}
