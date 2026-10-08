/**
 * Daily digest (upgrade 5): a compact Markdown summary of everything the bot
 * measured, written for an AI reviewer (the scheduled Claude Opus task) and
 * for you. It is small on purpose — a few KB instead of megabytes of JSONL —
 * so the review reads the facts, not the raw logs.
 *
 *   reports/digest-YYYY-MM-DD.md   one per day
 *   reports/digest-latest.md       always today's
 *
 * The reviewer reads the last 7 digests, compares strategies, routes, pools
 * and competitors, and writes its recommendations to reports/ai-review-*.md.
 * It never edits .env or switches modes: you apply anything it suggests.
 */
import type { LearningSummary, TuningView } from "./learn.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaySummary, OutcomeStats } from "./paper.js";
import type { MarketSummary } from "./classifier.js";
import type { LiqDaySummary } from "./liquidations.js";
import type { Settings } from "./config.js";
import type { RpcUsage } from "./rpc.js";

const usd = (n: number): string => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
const pct = (x: number | null): string => (x === null ? "–" : `${(x * 100).toFixed(0)}%`);

function md(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "_none_\n";
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n") + "\n";
}

function stats(rows: OutcomeStats[], label: string): string {
  return md(
    [label, "found", "landed", "taken", "closed", "win rate", "realistic net", "optimistic net"],
    rows.map((r) => [r.key, String(r.found), String(r.persisted), String(r.taken), String(r.closed), pct(r.winRate), usd(r.realisticNetUsd), usd(r.optimisticNetUsd)]),
  );
}

export interface DigestInput {
  day: string;
  settings: Settings;
  pools: { total: number; cl: number; pairs: number };
  borrowersWatched?: number;
  /** Most recent first; [0] is `day`. */
  paperDays: DaySummary[];
  market?: MarketSummary;
  liq?: LiqDaySummary;
  flashblockStats?: { ticks: number; scans: number; skippedUnchanged: number; opps: number; errors: number; maxMs: number };
  rpc?: RpcUsage;
  refreshStats?: { checks: number; driftedPools: number };
  /** Scanner funnel since start (where candidates drop out) and what the paper engine recorded. */
  funnel?: Record<string, number>;
  recorded?: { recorded: number; alreadyTracked: number } | undefined;
  /** The learning engine's summary and the settings you changed on the dashboard. */
  learning?: LearningSummary;
  tuning?: TuningView;
}

/** Rejection codes for the funnel stages, so the AI review and helper agents can refer to them. */
export const FUNNEL_STAGES: Array<{ key: string; code: string; label: string }> = [
  { key: "candidates", code: "CANDIDATE", label: "candidate route checks (positive spread after swap fees; one per route per block)" },
  { key: "unpriced", code: "NO_USD_PRICE", label: "profit token has no USD price" },
  { key: "gasAteIt", code: "NET_NEGATIVE_AFTER_GAS", label: "gas cost more than the spread" },
  { key: "belowMin", code: "NET_PROFIT_TOO_LOW", label: "net positive but below MIN_PROFIT_USD" },
  { key: "muted", code: "MUTED_AFTER_REVERT", label: "route reverted on-chain recently (muted 20 min)" },
  { key: "learnedSkip", code: "LEARNED_UNRELIABLE", label: "skipped by the learning engine: the route, a token or a pool keeps failing test runs" },
  { key: "overlapping", code: "OVERLAPS_BETTER_ROUTE", label: "shares a pool with a better route in the same block" },
  { key: "reverted", code: "SIMULATION_REVERT", label: "on-chain simulation reverted" },
  { key: "quoteMismatch", code: "QUOTE_MISMATCH", label: "DEX quoters disagreed with our maths" },
  { key: "unverified", code: "NOT_VERIFIED", label: "no on-chain check possible (local maths only)" },
  { key: "verified", code: "VERIFIED", label: "passed the on-chain check" },
];

export function renderDigest(d: DigestInput): string {
  const p = d.paperDays.find((x) => x.day === d.day);
  const s = d.settings;
  const out: string[] = [];
  out.push(`# Base arb bot digest — ${d.day}`);
  out.push("");
  out.push(`Generated ${new Date().toISOString()} · mode **${s.mode}** · ${d.pools.total} pools watched (${d.pools.cl} concentrated-liquidity) across ${d.pools.pairs} pairs.`);
  out.push("");
  out.push("## Settings in force");
  out.push(
    md(
      ["setting", "value"],
      [
        ["MIN_PROFIT_USD", String(s.minProfitUsd)],
        ["MIN_POOL_LIQUIDITY_WETH", String(s.minPoolLiquidityWeth)],
        ["MAX_POOLS", String(s.maxPools)],
        ["CL_POOLS / MULTI_HOP / MAX_HOPS", `${s.clPools} / ${s.multiHop} / ${s.maxHops}`],
        ["MAX_CYCLES", String(s.maxCycles)],
        ["PRIORITY_FEE_GWEI", String(s.priorityFeeGwei)],
        ["GAS model (base / V2 hop / CL hop)", `${s.gasRouteBase} / ${s.gasHopV2} / ${s.gasHopCl}`],
        ["FLASHBLOCKS (poll ms / max pools)", `${s.flashblocks} (${s.flashblockPollMs} / ${s.flashblockMaxPools})`],
        ["LIQUIDATIONS (check every / swap cost bps)", `${s.liquidations} (${s.liqCheckEvery} / ${s.liqSwapCostBps})`],
        ["TOKEN_BLACKLIST size", String(s.tokenBlacklist.size)],
        ["REFRESH_MODE / FULL_REFRESH_BLOCKS", `${s.refreshMode} / ${s.fullRefreshBlocks}`],
        ["RPC fallbacks", String(s.rpcFallbackUrls.length)],
      ],
    ),
  );

  out.push("## Paper trading — today");
  if (!p) out.push("_No opportunities recorded today._\n");
  else {
    const decided = p.persisted + p.taken + p.closed;
    out.push(
      md(
        ["found", "verified-fail", "landed", "taken", "closed", "pending", "hit rate", "realistic net", "optimistic net"],
        [[String(p.found), String(p.simMismatches), String(p.persisted), String(p.taken), String(p.closed), String(p.pending), decided ? pct(p.persisted / decided) : "–", usd(p.realisticNetUsd), usd(p.optimisticNetUsd)]],
      ),
    );
    out.push("### By strategy");
    out.push(stats(p.byKind, "strategy"));
    out.push("### Block vs Flashblock reaction");
    out.push(stats(p.byStage, "found on"));
    out.push("### Route win rates (verified opportunities only)");
    out.push(stats(p.scores.slice(0, 20), "route"));
    out.push("### Pairs");
    out.push(md(["pair / route", "found", "optimistic net"], p.byPair.slice(0, 10).map((r) => [r.pair, String(r.count), usd(r.netUsd)])));
    out.push("### Competitors who took our opportunities");
    const self = new Set([d.settings.executorAddress, d.settings.botAddress].filter((a): a is string => !!a).map((a) => a.toLowerCase()));
    out.push(md(["bot", "times"], p.takers.map((t) => [self.has(String(t.bot).toLowerCase()) ? `${t.bot} (this bot's own live trade, not a competitor)` : t.bot, String(t.count)])));
  }

  out.push("## Paper trading — last 7 days");
  out.push(
    md(
      ["day", "found", "landed", "taken", "closed", "realistic net", "optimistic net"],
      d.paperDays.slice(0, 7).map((x) => [x.day, String(x.found), String(x.persisted), String(x.taken), String(x.closed), usd(x.realisticNetUsd), usd(x.optimisticNetUsd)]),
    ),
  );

  if (d.rpc) {
    const r = d.rpc;
    out.push("## RPC usage (since start)");
    out.push(
      md(
        ["endpoint", "requests", "failovers", "est. Alchemy CU so far", "est. Alchemy CU/day at this pace"],
        [[r.activeEndpoint, String(r.requests), String(r.failovers), (r.alchemyCu / 1e6).toFixed(2) + "M", (r.alchemyCuPerDay / 1e6).toFixed(1) + "M"]],
      ),
    );
    out.push(md(["method", "calls"], Object.entries(r.byMethod).sort((a, b) => b[1] - a[1]).map(([m, n]) => [m, String(n)])));
  }
  if (d.refreshStats) {
    out.push(`Event-driven refresh self-checks: ${d.refreshStats.checks}, pools that drifted from a full re-read: ${d.refreshStats.driftedPools}.\n`);
  }

  if (d.funnel && d.funnel.candidates) {
    const f = d.funnel;
    out.push("## Why opportunities don't trade (block scanner, since start)");
    out.push(
      md(
        ["code", "stage", "count", "% of candidates"],
        FUNNEL_STAGES.map((st) => [st.code, st.label, String(f[st.key] ?? 0), `${(((f[st.key] ?? 0) / f.candidates!) * 100).toFixed(st.key === "candidates" ? 0 : 3)}%`]),
      ),
    );
    if (d.recorded) out.push(`Recorded as new paper opportunities: ${d.recorded.recorded}; skipped because the same route was already pending or just traded: ${d.recorded.alreadyTracked}.\n`);
  }

  if (d.learning) {
    const L = d.learning;
    out.push("## What the bot has learned");
    out.push(
      `Since ${L.since.slice(0, 10)}: ${L.counts.sims} test runs, ${L.counts.outcomes} outcomes, ${L.counts.rivalArbs} rival arbitrages, ${L.counts.liveSends} live sends; ${L.counts.routes} routes and ${L.counts.tokens} tokens tracked. Evidence halves every ${L.halfLifeHours} h. ` +
        `Verified finds still there one block later: classic ${(L.landRate.classic * 100).toFixed(0)}%, multi-hop ${(L.landRate.route * 100).toFixed(0)}%. ` +
        `Pools stopped watching (quiet for ${L.pools.pruneAfterDays} days or always failing): ${L.pools.prunedTotal}.\n`,
    );
    if (L.skipping.length) out.push(md(["token it skips", "failed", "test runs", "last failure"], L.skipping.map((t) => [t.sym, `${Math.round(t.p * 100)}%`, String(t.n), t.why.slice(0, 60)])));
    if (L.routes.length)
      out.push(
        md(
          ["route", "found", "test fail", "still there", "taken", "top rival", "live sent/landed", "bid x"],
          L.routes.slice(0, 10).map((r) => [r.label, String(r.found), r.testFail === null ? "–" : `${Math.round(r.testFail * 100)}%`, r.stillThere === null ? "–" : `${Math.round(r.stillThere * 100)}%`, r.takenShare === null ? "–" : `${Math.round(r.takenShare * 100)}%`, r.topRival ?? "–", r.live ? `${r.live.sent}/${r.live.ok}` : "–", String(r.bidMult)]),
        ),
      );
    out.push(md(["profit size", "rival bids seen", "p50 gwei", "p60 gwei", "p90 gwei"], L.bids.map((b) => [b.bucket, String(b.samples), String(b.p50 ?? "–"), String(b.p60 ?? "–"), String(b.p90 ?? "–")])));
  }
  if (d.tuning) {
    const t = d.tuning;
    const changed = Object.entries(t.overrides);
    out.push("## Settings changed on the dashboard");
    out.push(
      changed.length || t.blockedTokens.length
        ? `${changed.map(([k, v]) => `${k} = ${v} (.env: ${(t.fromEnv as Record<string, number>)[k]})`).join("; ")}${t.blockedTokens.length ? `${changed.length ? "; " : ""}blocked tokens: ${t.blockedTokens.map((b) => b.sym).join(", ")}` : ""}.\n`
        : "_None: everything comes from .env._\n",
    );
    if (t.suggestions.length) out.push(`Waiting for approval on the dashboard: ${t.suggestions.map((x) => x.title).join("; ")}.\n`);
    out.push(
      "To suggest a setting change, end the review with a ```json block: " +
        '{"suggestions": [{"key": "minProfitUsd" | "maxBidShare" | "evMinUsd", "value": number, "why": "…"}]}. ' +
        `Limits: minProfitUsd ${t.limits.minProfitUsd.min}-${t.limits.minProfitUsd.max}, maxBidShare ${t.limits.maxBidShare.min}-${t.limits.maxBidShare.max}, evMinUsd ${t.limits.evMinUsd.min}-${t.limits.evMinUsd.max}. They show on the dashboard for approval.\n`,
    );
  }

  if (d.flashblockStats) {
    const f = d.flashblockStats;
    out.push("## Flashblocks loop (since start)");
    out.push(md(["ticks", "scans", "unchanged (skipped)", "opps", "errors", "slowest tick ms"], [[String(f.ticks), String(f.scans), String(f.skippedUnchanged), String(f.opps), String(f.errors), String(f.maxMs)]]));
  }

  if (d.liq || d.borrowersWatched !== undefined) {
    const l = d.liq;
    out.push("## Aave V3 liquidations — today");
    out.push(`Borrowers watched: ${d.borrowersWatched ?? "?"}\n`);
    if (!l) out.push("_No liquidatable positions today._\n");
    else {
      out.push(md(["found", "open (ours)", "taken", "recovered", "realistic profit", "estimated profit"], [[String(l.found), String(l.open), String(l.taken), String(l.recovered), usd(l.realisticProfitUsd), usd(l.estProfitUsd)]]));
      out.push(md(["user", "repay → seize", "repay", "est. profit", "outcome"], l.biggest.map((b) => [b.user, `${b.debtSymbol} → ${b.collateralSymbol}`, usd(b.repayUsd), usd(b.estProfitUsd), b.status])));
      out.push(md(["liquidator", "times"], l.liquidators.map((x) => [x.bot, String(x.count)])));
    }
  }

  const m = d.market;
  out.push("## Base MEV market — today");
  if (!m) out.push("_No MEV transactions recorded._\n");
  else {
    out.push(`Arbitrage txs ${m.arbitrageTxs} (${usd(m.arbitrageProfitUsd)}), sandwiches ${m.sandwichTxs} (${usd(m.sandwichProfitUsd)}).\n`);
    out.push(md(["bot", "txs", "arb", "profit", "gas"], m.bots.slice(0, 10).map((b) => [b.bot, String(b.txs), String(b.arbitrage), usd(b.profitUsd), usd(b.costUsd)])));
    out.push(md(["most arbed pair", "txs", "profit"], m.topPairs.slice(0, 10).map((x) => [x.pair, String(x.txs), usd(x.profitUsd)])));
    if (m.arbPriority?.samples) {
      out.push(
        `Priority fees paid by arbitrage txs (${m.arbPriority.samples} receipts): median ${m.arbPriority.medianGwei?.toFixed(4)} gwei, p90 ${m.arbPriority.p90Gwei?.toFixed(4)} gwei, max ${m.arbPriority.maxGwei?.toFixed(4)} gwei (our PRIORITY_FEE_GWEI: ${s.priorityFeeGwei}).\n`,
      );
    }
    out.push(md(["dex combination", "txs", "profit"], m.topDexRoutes.slice(0, 8).map((x) => [x.route, String(x.txs), usd(x.profitUsd)])));
  }
  return out.join("\n");
}

export function writeDigest(dir: string, day: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `digest-${day}.md`);
  writeFileSync(file, text);
  writeFileSync(join(dir, "digest-latest.md"), text);
  return file;
}
