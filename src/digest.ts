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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaySummary, OutcomeStats } from "./paper.js";
import type { MarketSummary } from "./classifier.js";
import type { LiqDaySummary } from "./liquidations.js";
import type { Settings } from "./config.js";

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
}

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
    out.push(md(["bot", "times"], p.takers.map((t) => [t.bot, String(t.count)])));
  }

  out.push("## Paper trading — last 7 days");
  out.push(
    md(
      ["day", "found", "landed", "taken", "closed", "realistic net", "optimistic net"],
      d.paperDays.slice(0, 7).map((x) => [x.day, String(x.found), String(x.persisted), String(x.taken), String(x.closed), usd(x.realisticNetUsd), usd(x.optimisticNetUsd)]),
    ),
  );

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
