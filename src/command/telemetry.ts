/**
 * Pure computations behind the command center: latency, leaks, racers,
 * route scores, the replay simulator and the Base part of the atlas.
 *
 * Everything here takes the bot's own records (data/*.jsonl, already
 * parsed) and returns plain objects, so it is tested without a chain and an
 * agent can reproduce any number from the raw files.
 *
 * Honesty rules:
 *   - a measurement says what it measured (e.g. `detectMs` is msIntoBlock,
 *     the time into the 2 s block when WE saw the gap, not a rival's speed)
 *   - modelled numbers are labelled (`simulate().model`)
 *   - unknowns are null, never invented
 */

export interface OppLite {
  id: string;
  block: number;
  foundAt: string;
  pairSymbols: string;
  buyDex: string;
  sellDex: string;
  dexes?: string[];
  netUsd: number;
  profitUsd: number;
  gasUsd: number;
  stage?: "block" | "flashblock";
  msIntoBlock?: number;
  hops?: number;
}

export interface OutcomeLite {
  id: string;
  block: number;
  status: "persisted" | "taken" | "closed";
  realisticNetUsd: number;
  takenBy?: string;
  takenBlock?: number;
}

export interface MevLite {
  block: number;
  timestamp: string;
  txIndex: number;
  bot: string;
  sender: string;
  dexes: string[];
  tokens: string[];
  profitUsd: number | null;
  costUsd?: number;
  priorityGwei?: number;
  type: "arbitrage" | "sandwich";
}

export interface LiveLite {
  id: string;
  block: number;
  sentAt: string;
  status: "pending" | "success" | "reverted" | "dropped";
  priorityFeeGwei: number;
  expectedProfitUsd: number;
  gasUsd?: number;
  minedBlock?: number;
}

export interface Funnel {
  candidates?: number;
  gasAteIt?: number;
  belowMin?: number;
  verified?: number;
  reverted?: number;
  learnedSkip?: number;
}

const HOUR = 3_600_000;

export function quantile(values: number[], q: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))));
  return v[i]!;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const within = (iso: string, now: number, ms: number): boolean => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && now - t <= ms && t <= now + 60_000;
};

/** live.jsonl holds a "pending" line then a final one per send: keep the last line per id. */
export function finalLives(lives: LiveLite[]): LiveLite[] {
  const m = new Map<string, LiveLite>();
  for (const l of lives) m.set(l.id, l);
  return [...m.values()];
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

export interface Latency {
  windowHours: number;
  /** ms into the block when we found the gap (msIntoBlock): our detection lag. */
  detectP50: number | null;
  detectP90: number | null;
  /** ms from finding a gap to broadcasting the transaction (live sends only). */
  sendP50: number | null;
  sendP90: number | null;
  /** Blocks from the gap's block to the block our send was mined in. */
  landBlocksP50: number | null;
  /** detect p50 + send p50: our median time from the state change to a signed send in flight. */
  toSendP50: number | null;
  samples: { detect: number; send: number; land: number };
  /** Hourly detect p50/p90 for the trend chart, oldest first. */
  hourly: Array<{ hour: string; p50: number | null; p90: number | null; n: number }>;
}

export function latency(opps: OppLite[], lives: LiveLite[], now = Date.now(), windowHours = 24): Latency {
  const win = windowHours * HOUR;
  const recent = opps.filter((o) => within(o.foundAt, now, win));
  const detect = recent.map((o) => o.msIntoBlock).filter((x): x is number => typeof x === "number" && x >= 0 && x < 60_000);
  const byId = new Map(recent.map((o) => [o.id, o]));
  const sent = finalLives(lives).filter((l) => within(l.sentAt, now, win));
  const send: number[] = [];
  const land: number[] = [];
  for (const l of sent) {
    const o = byId.get(l.id);
    if (o) {
      const d = Date.parse(l.sentAt) - Date.parse(o.foundAt);
      if (d >= 0 && d < 120_000) send.push(d);
    }
    if (l.status === "success" && typeof l.minedBlock === "number" && l.minedBlock >= l.block) land.push(l.minedBlock - l.block);
  }
  const hourly: Latency["hourly"] = [];
  for (let h = windowHours - 1; h >= 0; h--) {
    const lo = now - (h + 1) * HOUR;
    const hi = now - h * HOUR;
    const xs = recent
      .filter((o) => {
        const t = Date.parse(o.foundAt);
        return t > lo && t <= hi;
      })
      .map((o) => o.msIntoBlock)
      .filter((x): x is number => typeof x === "number" && x >= 0);
    hourly.push({ hour: new Date(hi).toISOString().slice(0, 13) + ":00Z", p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), n: xs.length });
  }
  const dp50 = quantile(detect, 0.5);
  const sp50 = quantile(send, 0.5);
  return {
    windowHours,
    detectP50: dp50,
    detectP90: quantile(detect, 0.9),
    sendP50: sp50,
    sendP90: quantile(send, 0.9),
    landBlocksP50: quantile(land, 0.5),
    toSendP50: dp50 !== null && sp50 !== null ? dp50 + sp50 : null,
    samples: { detect: detect.length, send: send.length, land: land.length },
    hourly,
  };
}

// ---------------------------------------------------------------------------
// Leaks: where the edge we saw went
// ---------------------------------------------------------------------------

export interface Leaks {
  windowHours: number;
  /** Live sends that landed (expected profit at send time). */
  captured: { n: number; usd: number };
  /** Paper finds still there a block later: what we would have banked. */
  persisted: { n: number; usd: number };
  /** Finds another bot took first, plus our live sends that reverted: the latency race. */
  lostRace: { n: number; usd: number; liveReverts: number };
  /** Gaps that closed before anyone (no taker identified). */
  closed: { n: number; usd: number };
  /** Since this start: candidates whose gas cost more than the spread, and net-positive ones under MIN_PROFIT_USD. */
  gasWall: { n: number };
  belowMin: { n: number };
  /** Who took our finds most often. */
  topTakers: Array<{ bot: string; n: number; usd: number }>;
}

export function leaks(opps: OppLite[], outcomes: OutcomeLite[], lives: LiveLite[], funnel: Funnel | undefined, now = Date.now(), windowHours = 6): Leaks {
  const win = windowHours * HOUR;
  const recent = new Map(opps.filter((o) => within(o.foundAt, now, win)).map((o) => [o.id, o]));
  const out = { persisted: { n: 0, usd: 0 }, taken: { n: 0, usd: 0 }, closed: { n: 0, usd: 0 } };
  const takers = new Map<string, { n: number; usd: number }>();
  for (const oc of outcomes) {
    const o = recent.get(oc.id);
    if (!o) continue;
    if (oc.status === "persisted") {
      out.persisted.n++;
      out.persisted.usd += oc.realisticNetUsd;
    } else if (oc.status === "taken") {
      out.taken.n++;
      out.taken.usd += Math.max(0, o.netUsd);
      if (oc.takenBy) {
        const t = takers.get(oc.takenBy) ?? { n: 0, usd: 0 };
        t.n++;
        t.usd += Math.max(0, o.netUsd);
        takers.set(oc.takenBy, t);
      }
    } else {
      out.closed.n++;
      out.closed.usd += Math.max(0, o.netUsd);
    }
  }
  const fl = finalLives(lives).filter((l) => within(l.sentAt, now, win));
  const landed = fl.filter((l) => l.status === "success");
  const reverts = fl.filter((l) => l.status === "reverted").length;
  return {
    windowHours,
    captured: { n: landed.length, usd: r2(landed.reduce((s, l) => s + l.expectedProfitUsd, 0)) },
    persisted: { n: out.persisted.n, usd: r2(out.persisted.usd) },
    lostRace: { n: out.taken.n + reverts, usd: r2(out.taken.usd), liveReverts: reverts },
    closed: { n: out.closed.n, usd: r2(out.closed.usd) },
    gasWall: { n: funnel?.gasAteIt ?? 0 },
    belowMin: { n: funnel?.belowMin ?? 0 },
    topTakers: [...takers.entries()]
      .map(([bot, v]) => ({ bot, n: v.n, usd: r2(v.usd) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Racers: the bots making money on our chain right now
// ---------------------------------------------------------------------------

export interface Racer {
  bot: string;
  you: boolean;
  trades: number;
  tradesPerHour: number;
  profitUsd: number;
  usdPerHour: number;
  /** Share of all arbitrage profit seen in the window. */
  share: number;
  medianPriorityGwei: number | null;
  /** Median position in the block (lower = earlier). */
  medianTxIndex: number | null;
  /** How many of OUR finds this bot took first. */
  takesFromUs: number;
  topRoute: string | null;
  lastSeen: string;
}

export function racers(
  mev: MevLite[],
  outcomes: OutcomeLite[],
  lives: LiveLite[],
  self: string[],
  now = Date.now(),
  windowHours = 1,
): { windowHours: number; rows: Racer[]; totalProfitUsd: number } {
  const win = windowHours * HOUR;
  const mine = new Set(self.map((a) => a.toLowerCase()));
  type Agg = { trades: number; profit: number; fees: number[]; idx: number[]; routes: Map<string, number>; last: string };
  const m = new Map<string, Agg>();
  for (const d of mev) {
    if (d.type !== "arbitrage" || !within(d.timestamp, now, win)) continue;
    const bot = d.bot.toLowerCase();
    if (mine.has(bot) || mine.has(d.sender.toLowerCase())) continue;
    const e: Agg = m.get(bot) ?? { trades: 0, profit: 0, fees: [], idx: [], routes: new Map(), last: d.timestamp };
    e.trades++;
    e.profit += d.profitUsd ?? 0;
    if (typeof d.priorityGwei === "number") e.fees.push(d.priorityGwei);
    e.idx.push(d.txIndex);
    const route = [...new Set(d.dexes)].join(" ↔ ");
    e.routes.set(route, (e.routes.get(route) ?? 0) + 1);
    if (d.timestamp > e.last) e.last = d.timestamp;
    m.set(bot, e);
  }
  const takes = new Map<string, number>();
  for (const oc of outcomes) if (oc.status === "taken" && oc.takenBy) takes.set(oc.takenBy.toLowerCase(), (takes.get(oc.takenBy.toLowerCase()) ?? 0) + 1);
  const total = [...m.values()].reduce((s, e) => s + e.profit, 0);
  const rows: Racer[] = [...m.entries()].map(([bot, e]) => {
    const top = [...e.routes.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      bot,
      you: false,
      trades: e.trades,
      tradesPerHour: r2(e.trades / windowHours),
      profitUsd: r2(e.profit),
      usdPerHour: r2(e.profit / windowHours),
      share: total > 0 ? r2(e.profit / total) : 0,
      medianPriorityGwei: quantile(e.fees, 0.5),
      medianTxIndex: quantile(e.idx, 0.5),
      takesFromUs: takes.get(bot) ?? 0,
      topRoute: top ? top[0] : null,
      lastSeen: e.last,
    };
  });
  rows.sort((a, b) => b.usdPerHour - a.usdPerHour || b.trades - a.trades);
  const ours = finalLives(lives).filter((l) => l.status === "success" && within(l.sentAt, now, win));
  const ourProfit = ours.reduce((s, l) => s + l.expectedProfitUsd, 0);
  rows.splice(Math.min(rows.length, 7), Infinity);
  rows.push({
    bot: self[0]?.toLowerCase() ?? "base-arb-bot",
    you: true,
    trades: ours.length,
    tradesPerHour: r2(ours.length / windowHours),
    profitUsd: r2(ourProfit),
    usdPerHour: r2(ourProfit / windowHours),
    share: total + ourProfit > 0 ? r2(ourProfit / (total + ourProfit)) : 0,
    medianPriorityGwei: quantile(ours.map((l) => l.priorityFeeGwei), 0.5),
    medianTxIndex: null,
    takesFromUs: 0,
    topRoute: null,
    lastSeen: ours.at(-1)?.sentAt ?? "",
  });
  return { windowHours, rows, totalProfitUsd: r2(total) };
}

// ---------------------------------------------------------------------------
// Daily route scores
// ---------------------------------------------------------------------------

export interface RouteScore {
  pair: string;
  score: number;
  finds: number;
  /** Net we'd have banked (persisted) plus net lost to rivals (taken): what speed could recover. */
  recoverableUsd: number;
  /** Persisted / decided outcomes: how often the gap was still ours to take. */
  winRate: number | null;
  avgEdgeUsd: number;
  /** Gas as a share of gross edge. */
  gasShare: number;
  bestRoute: string;
  /** Finds per 4-hour slice over the day, oldest first. */
  trend: number[];
}

export function routeScores(opps: OppLite[], outcomes: OutcomeLite[], now = Date.now()): RouteScore[] {
  const day = opps.filter((o) => within(o.foundAt, now, 24 * HOUR));
  const oc = new Map(outcomes.map((o) => [o.id, o]));
  const g = new Map<string, { opps: OppLite[] }>();
  for (const o of day) {
    const e = g.get(o.pairSymbols) ?? { opps: [] };
    e.opps.push(o);
    g.set(o.pairSymbols, e);
  }
  const rows: RouteScore[] = [];
  for (const [pair, e] of g) {
    let recov = 0;
    let persisted = 0;
    let decided = 0;
    let gross = 0;
    let gas = 0;
    const routes = new Map<string, number>();
    const trend = [0, 0, 0, 0, 0, 0];
    for (const o of e.opps) {
      gross += Math.max(0, o.profitUsd);
      gas += Math.max(0, o.gasUsd);
      const rk = `${o.buyDex} ↔ ${o.sellDex}`;
      routes.set(rk, (routes.get(rk) ?? 0) + 1);
      const age = now - Date.parse(o.foundAt);
      const slot = 5 - Math.min(5, Math.floor(age / (4 * HOUR)));
      trend[slot] = (trend[slot] ?? 0) + 1;
      const x = oc.get(o.id);
      if (!x) continue;
      decided++;
      if (x.status === "persisted") {
        persisted++;
        recov += x.realisticNetUsd;
      } else if (x.status === "taken") recov += Math.max(0, o.netUsd);
    }
    const winRate = decided ? persisted / decided : null;
    const gasShare = gross > 0 ? Math.min(1, gas / gross) : 1;
    const score = Math.round(recov * (0.25 + (winRate ?? 0)) * (1.3 - gasShare) * 10);
    rows.push({
      pair,
      score: Math.max(0, score),
      finds: e.opps.length,
      recoverableUsd: r2(recov),
      winRate: winRate === null ? null : r2(winRate),
      avgEdgeUsd: r2(gross / e.opps.length),
      gasShare: r2(gasShare),
      bestRoute: [...routes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
      trend,
    });
  }
  return rows.sort((a, b) => b.score - a.score || b.recoverableUsd - a.recoverableUsd);
}

// ---------------------------------------------------------------------------
// Replay simulator
// ---------------------------------------------------------------------------

export interface SimConfig {
  minProfitUsd: number;
  /** Multiplier on recorded gas (0.5 = gas halves, 3 = triples). */
  gasX: number;
  /** How many ms faster our send path is than when these finds were recorded (Ashburn ≈ 230). */
  latencyCutMs: number;
  /** Median ms we were behind the winning bot when these finds were recorded. */
  gapMs: number;
  excludeDexes: string[];
}

export interface SimResult {
  config: SimConfig;
  finds: number;
  excluded: number;
  gasWall: number;
  belowMin: number;
  /** Persisted finds: banked at the replayed net. */
  bankedUsd: number;
  /** Taken finds we'd now win, weighted by the latency model. */
  wonBackUsd: number;
  stillLostUsd: number;
  closed: number;
  undecided: number;
  capturedUsd: number;
  model: string;
}

export function simulate(opps: OppLite[], outcomes: OutcomeLite[], cfg: SimConfig): SimResult {
  const oc = new Map(outcomes.map((o) => [o.id, o]));
  const ex = new Set(cfg.excludeDexes.map((d) => d.toLowerCase()));
  const pWin = cfg.gapMs > 0 ? Math.min(1, Math.max(0, cfg.latencyCutMs / cfg.gapMs)) : cfg.latencyCutMs > 0 ? 1 : 0;
  const res: SimResult = { config: cfg, finds: opps.length, excluded: 0, gasWall: 0, belowMin: 0, bankedUsd: 0, wonBackUsd: 0, stillLostUsd: 0, closed: 0, undecided: 0, capturedUsd: 0, model: "" };
  for (const o of opps) {
    const dexes = (o.dexes?.length ? o.dexes : [o.buyDex, o.sellDex]).map((d) => d.toLowerCase());
    if (dexes.some((d) => ex.has(d))) {
      res.excluded++;
      continue;
    }
    const net = o.profitUsd - o.gasUsd * cfg.gasX;
    if (net <= 0) {
      res.gasWall++;
      continue;
    }
    if (net < cfg.minProfitUsd) {
      res.belowMin++;
      continue;
    }
    const x = oc.get(o.id);
    if (!x) {
      res.undecided++;
      continue;
    }
    if (x.status === "persisted") res.bankedUsd += net;
    else if (x.status === "taken") {
      res.wonBackUsd += net * pWin;
      res.stillLostUsd += net * (1 - pWin);
    } else res.closed++;
  }
  res.bankedUsd = r2(res.bankedUsd);
  res.wonBackUsd = r2(res.wonBackUsd);
  res.stillLostUsd = r2(res.stillLostUsd);
  res.capturedUsd = r2(res.bankedUsd + res.wonBackUsd);
  res.model =
    `Gas, minimum and venue filters replay exactly. Races are modelled: a find a rival took is won back with probability ` +
    `min(1, latencyCut / gap) = ${(pWin * 100).toFixed(0)}% (gap ${cfg.gapMs} ms).`;
  return res;
}

// ---------------------------------------------------------------------------
// Atlas (Base, from data)
// ---------------------------------------------------------------------------

export interface AtlasRoute {
  id: string;
  label: string;
  owner: "ours" | "rival" | "open";
  bot: string;
  network: "base";
  venues: string[];
  pair: string;
  count: number;
  usd: number;
}

export function atlasBase(opps: OppLite[], mev: MevLite[], symbol: (addr: string) => string, self: string[], now = Date.now()): { venues: string[]; pairs: string[]; routes: AtlasRoute[] } {
  const day = 24 * HOUR;
  const mine = new Set(self.map((a) => a.toLowerCase()));
  const ours = new Map<string, AtlasRoute>();
  for (const o of opps) {
    if (!within(o.foundAt, now, day)) continue;
    const key = `${o.buyDex}|${o.sellDex}|${o.pairSymbols}`;
    const r = ours.get(key) ?? { id: "o:" + key, label: `${o.pairSymbols} · ${o.buyDex} ↔ ${o.sellDex}`, owner: "ours", bot: "base-arb-bot", network: "base", venues: [o.buyDex, o.sellDex], pair: o.pairSymbols, count: 0, usd: 0 };
    r.count++;
    r.usd += Math.max(0, o.netUsd);
    ours.set(key, r);
  }
  const rivals = new Map<string, AtlasRoute>();
  for (const d of mev) {
    if (d.type !== "arbitrage" || !within(d.timestamp, now, day)) continue;
    if (mine.has(d.bot.toLowerCase())) continue;
    const venues = [...new Set(d.dexes)].slice(0, 3);
    const pair = d.tokens.slice(0, 2).map(symbol).join("/");
    const key = `${d.bot}|${venues.join("|")}|${pair}`;
    const r = rivals.get(key) ?? { id: "r:" + key, label: `${pair} · ${venues.join(" ↔ ")}`, owner: "rival", bot: d.bot, network: "base", venues, pair, count: 0, usd: 0 };
    r.count++;
    r.usd += d.profitUsd ?? 0;
    rivals.set(key, r);
  }
  const top = (m: Map<string, AtlasRoute>, n: number): AtlasRoute[] =>
    [...m.values()]
      .sort((a, b) => b.usd - a.usd || b.count - a.count)
      .slice(0, n)
      .map((r) => ({ ...r, usd: r2(r.usd) }));
  const routes = [...top(ours, 8), ...top(rivals, 8)];
  const venues = [...new Set(routes.flatMap((r) => r.venues))];
  const pairs = [...new Set(routes.map((r) => r.pair))];
  return { venues, pairs, routes };
}

// ---------------------------------------------------------------------------
// Hourly buckets for the analytics charts
// ---------------------------------------------------------------------------

export interface HourBucket {
  /** Bucket end, ISO hour ("2026-10-11T14:00Z"). */
  hour: string;
  finds: number;
  persisted: number;
  taken: number;
  closed: number;
  /** Paper: realistic net of finds still there a block later (what we'd have banked). */
  paperNetUsd: number;
  sends: number;
  landed: number;
  reverted: number;
  /** Live: expected profit of landed sends minus the gas of every send. */
  liveNetUsd: number;
  gasUsd: number;
  detectP50: number | null;
  detectP90: number | null;
  rivalTrades: number;
  rivalUsd: number;
  rivalPriorityGwei: number | null;
}

export function hourly(opps: OppLite[], outcomes: OutcomeLite[], lives: LiveLite[], mev: MevLite[], self: string[], now = Date.now(), hours = 24): HourBucket[] {
  const start = now - hours * HOUR;
  const slot = (iso: string): number => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t <= start || t > now + 60_000) return -1;
    return Math.min(hours - 1, Math.floor((t - start) / HOUR));
  };
  const b: Array<HourBucket & { ms: number[]; fees: number[] }> = [];
  for (let h = 0; h < hours; h++)
    b.push({
      hour: new Date(start + (h + 1) * HOUR).toISOString().slice(0, 13) + ":00Z",
      finds: 0, persisted: 0, taken: 0, closed: 0, paperNetUsd: 0,
      sends: 0, landed: 0, reverted: 0, liveNetUsd: 0, gasUsd: 0,
      detectP50: null, detectP90: null, rivalTrades: 0, rivalUsd: 0, rivalPriorityGwei: null,
      ms: [], fees: [],
    });
  const where = new Map<string, number>();
  for (const o of opps) {
    const i = slot(o.foundAt);
    if (i < 0) continue;
    where.set(o.id, i);
    b[i]!.finds++;
    if (typeof o.msIntoBlock === "number" && o.msIntoBlock >= 0) b[i]!.ms.push(o.msIntoBlock);
  }
  for (const oc of outcomes) {
    const i = where.get(oc.id);
    if (i === undefined) continue;
    if (oc.status === "persisted") {
      b[i]!.persisted++;
      b[i]!.paperNetUsd += oc.realisticNetUsd;
    } else if (oc.status === "taken") b[i]!.taken++;
    else b[i]!.closed++;
  }
  for (const l of finalLives(lives)) {
    const i = slot(l.sentAt);
    if (i < 0) continue;
    const x = b[i]!;
    x.sends++;
    x.gasUsd += l.gasUsd ?? 0;
    x.liveNetUsd -= l.gasUsd ?? 0;
    if (l.status === "success") {
      x.landed++;
      x.liveNetUsd += l.expectedProfitUsd;
    } else if (l.status === "reverted") x.reverted++;
  }
  const mine = new Set(self.map((a) => a.toLowerCase()));
  for (const d of mev) {
    if (d.type !== "arbitrage" || mine.has(d.bot.toLowerCase())) continue;
    const i = slot(d.timestamp);
    if (i < 0) continue;
    b[i]!.rivalTrades++;
    b[i]!.rivalUsd += d.profitUsd ?? 0;
    if (typeof d.priorityGwei === "number") b[i]!.fees.push(d.priorityGwei);
  }
  return b.map(({ ms, fees, ...x }) => ({
    ...x,
    paperNetUsd: r2(x.paperNetUsd),
    liveNetUsd: r2(x.liveNetUsd),
    gasUsd: Math.round(x.gasUsd * 10_000) / 10_000,
    rivalUsd: r2(x.rivalUsd),
    detectP50: quantile(ms, 0.5),
    detectP90: quantile(ms, 0.9),
    rivalPriorityGwei: quantile(fees, 0.5),
  }));
}
