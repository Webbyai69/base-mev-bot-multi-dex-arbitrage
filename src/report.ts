/**
 * Daily HTML report: your paper-trading results next to the Base MEV market
 * (arbitrage/sandwich volume, bot leaderboard, most-arbed pairs, watched bots).
 * Self-contained (inline CSS/SVG), light & dark aware, no external assets.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaySummary, OutcomeStats } from "./paper.js";
import type { MarketSummary } from "./classifier.js";
import type { LiqDaySummary } from "./liquidations.js";

const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const usd = (n: number): string => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);

function statTile(label: string, value: string, note?: string, tone?: "good" | "bad"): string {
  const cls = tone ? ` tile-${tone}` : "";
  return `<div class="tile${cls}"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${note ? `<div class="tile-note">${esc(note)}</div>` : ""}</div>`;
}

function table(headers: string[], rows: string[][], empty = "Nothing yet"): string {
  if (rows.length === 0) return `<p class="empty">${esc(empty)}</p>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${i === 0 ? "" : "num"}">${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

/** Single-series bar chart (hourly MEV transactions) as inline SVG. */
function hourlyChart(hourly: Array<{ hour: string; txs: number; profitUsd: number }>): string {
  if (hourly.length === 0) return `<p class="empty">No MEV transactions recorded yet today.</p>`;
  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  const byHour = new Map(hourly.map((h) => [h.hour, h]));
  const data = hours.map((h) => byHour.get(h) ?? { hour: h, txs: 0, profitUsd: 0 });
  const max = Math.max(1, ...data.map((d) => d.txs));
  const W = 720, H = 180, padL = 36, padB = 24, padT = 12;
  const plotW = W - padL - 8, plotH = H - padT - padB;
  const slot = plotW / 24;
  const barW = Math.max(4, slot - 2);
  const bars = data
    .map((d, i) => {
      const h = (d.txs / max) * plotH;
      const x = padL + i * slot + 1;
      const y = padT + plotH - h;
      const r = Math.min(4, h / 2);
      // Rounded top only, anchored to the baseline.
      const path = h <= 0 ? "" : `M${x},${y + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} h-${barW} z`;
      return `<path d="${path}" class="bar"><title>${d.hour}: ${d.txs} MEV tx, ${usd(d.profitUsd)} profit</title></path>`;
    })
    .join("");
  const ticks = [0, Math.round(max / 2), max]
    .map((t) => {
      const y = padT + plotH - (t / max) * plotH;
      return `<line x1="${padL}" x2="${W - 8}" y1="${y}" y2="${y}" class="grid"/><text x="${padL - 6}" y="${y + 4}" class="tick" text-anchor="end">${t}</text>`;
    })
    .join("");
  const labels = [0, 6, 12, 18, 23]
    .map((h) => `<text x="${padL + h * slot + barW / 2}" y="${H - 6}" class="tick" text-anchor="middle">${hours[h]}</text>`)
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="MEV transactions per hour (UTC)" class="chart">${ticks}<line x1="${padL}" x2="${W - 8}" y1="${padT + plotH}" y2="${padT + plotH}" class="axis"/>${bars}${labels}</svg>`;
}

function statsTable(rows: OutcomeStats[], keyLabel: string, empty: string): string {
  return table(
    [keyLabel, "Found", "Landed", "Taken", "Closed", "Win rate", "Realistic net"],
    rows.map((r) => [esc(r.key), String(r.found), String(r.persisted), String(r.taken), String(r.closed), r.winRate === null ? "–" : `${(r.winRate * 100).toFixed(0)}%`, usd(r.realisticNetUsd)]),
    empty,
  );
}

function liquidationSection(l: LiqDaySummary | undefined, watched: number | undefined): string {
  if (!l && watched === undefined) return "";
  const s = l ?? { found: 0, taken: 0, recovered: 0, open: 0, estProfitUsd: 0, realisticProfitUsd: 0, liquidators: [], biggest: [] };
  return `
  <h2>Aave V3 liquidations (paper)</h2>
  <div class="tiles">
    ${statTile("Liquidatable positions", String(s.found), watched !== undefined ? `out of ${watched} borrowers watched` : undefined)}
    ${statTile("Would have been ours", String(s.open), "nobody liquidated them in time", s.open > 0 ? "good" : undefined)}
    ${statTile("Taken by others", String(s.taken), `${s.recovered} recovered on their own`, s.taken > 0 ? "bad" : undefined)}
    ${statTile("Realistic profit", usd(s.realisticProfitUsd), `estimate across all: ${usd(s.estProfitUsd)}`, s.realisticProfitUsd > 0 ? "good" : undefined)}
  </div>
  <div class="two" style="margin-top:14px">
    <div class="card"><h2 style="margin-top:0">Biggest positions</h2>
      ${table(["User", "Repay → seize", "Repay", "Est. profit", "Outcome"], s.biggest.map((b) => [`<span class="mono">${esc(short(b.user))}</span>`, esc(`${b.debtSymbol} → ${b.collateralSymbol}`), usd(b.repayUsd), usd(b.estProfitUsd), esc(b.status)]), "No liquidatable positions yet")}</div>
    <div class="card"><h2 style="margin-top:0">Liquidators who beat us</h2>
      ${table(["Liquidator", "Times"], s.liquidators.map((r) => [`<span class="mono">${esc(short(r.bot))}</span>`, String(r.count)]), "Nobody yet")}</div>
  </div>`;
}

export function renderReport(
  day: string,
  paper: DaySummary | undefined,
  market: MarketSummary | undefined,
  meta: { mode: string; pools: number; pairs: number; ethUsd: number; clPools?: number; borrowersWatched?: number },
  liq?: LiqDaySummary,
): string {
  const p = paper ?? { day, found: 0, optimisticNetUsd: 0, realisticNetUsd: 0, persisted: 0, taken: 0, closed: 0, pending: 0, gasUsd: 0, byPair: [], byRoute: [], takers: [], simMismatches: 0, byKind: [], byStage: [], scores: [] };
  const m = market ?? { day, arbitrageTxs: 0, sandwichTxs: 0, arbitrageProfitUsd: 0, sandwichProfitUsd: 0, bots: [], topPairs: [], topDexRoutes: [], hourly: [], watched: [] };
  const decided = p.persisted + p.taken + p.closed;
  const hitRate = decided ? `${((p.persisted / decided) * 100).toFixed(0)}% of decided opportunities would have landed` : "no opportunities decided yet";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Base arb bot — ${esc(day)}</title>
<style>
  :root { color-scheme: light dark;
    --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781; --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
    --series-1:#2a78d6; --series-2:#eb6834; --good:#006300; --bad:#d03b3b; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --page:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink-2:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
    --series-1:#3987e5; --series-2:#d95926; --good:#0ca30c; --bad:#e66767; } }
  :root[data-theme="dark"] {
    --page:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink-2:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
    --series-1:#3987e5; --series-2:#d95926; --good:#0ca30c; --bad:#e66767; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); color:var(--ink); font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:1040px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:32px 0 10px; } .sub { color:var(--ink-2); margin:0 0 20px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; }
  .tile { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
  .tile-label { font-size:12px; color:var(--ink-2); } .tile-value { font-size:26px; font-weight:600; margin-top:2px; } .tile-note { font-size:12px; color:var(--muted); margin-top:2px; }
  .tile-good .tile-value { color:var(--good); } .tile-bad .tile-value { color:var(--bad); }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; } th { text-align:left; color:var(--ink-2); font-weight:500; border-bottom:1px solid var(--grid); padding:6px 8px; }
  td { padding:6px 8px; border-bottom:1px solid var(--grid); } td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; } tr:last-child td { border-bottom:0; }
  .empty { color:var(--muted); margin:6px 0; } .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
  .chart { width:100%; height:auto; display:block; } .bar { fill:var(--series-1); } .bar:hover { fill:var(--series-2); } .grid { stroke:var(--grid); stroke-width:1; } .axis { stroke:var(--axis); stroke-width:1; } .tick { fill:var(--muted); font-size:11px; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:14px; } @media (max-width:760px) { .two { grid-template-columns:1fr; } }
  footer { color:var(--muted); font-size:12px; margin-top:32px; }
</style>
</head>
<body>
<main>
  <h1>Base arbitrage bot — ${esc(day)}</h1>
  <p class="sub">Mode: <strong>${esc(meta.mode)}</strong> · watching ${meta.pools} pools${meta.clPools ? ` (${meta.clPools} concentrated-liquidity)` : ""} across ${meta.pairs} token pairs · ETH ${usd(meta.ethUsd)}</p>

  <h2>Your bot (paper trading)</h2>
  <div class="tiles">
    ${statTile("Opportunities found", String(p.found), `${p.simMismatches} failed on-chain verification`)}
    ${statTile("Optimistic net", usd(p.optimisticNetUsd), "if every one had been captured")}
    ${statTile("Realistic net", usd(p.realisticNetUsd), hitRate, p.realisticNetUsd > 0 ? "good" : undefined)}
    ${statTile("Would have landed", String(p.persisted), "still open at the next block", p.persisted > 0 ? "good" : undefined)}
    ${statTile("Taken by others", String(p.taken), "another bot got there first", p.taken > 0 ? "bad" : undefined)}
    ${statTile("Closed by the market", String(p.closed), `${p.pending} still pending`)}
  </div>
  <div class="two" style="margin-top:14px">
    <div class="card"><h2 style="margin-top:0">Pairs with the most opportunity</h2>
      ${table(["Pair", "Found", "Net (optimistic)"], p.byPair.map((r) => [esc(r.pair), String(r.count), usd(r.netUsd)]))}</div>
    <div class="card"><h2 style="margin-top:0">Routes</h2>
      ${table(["Buy → sell", "Found", "Net (optimistic)"], p.byRoute.map((r) => [esc(r.route), String(r.count), usd(r.netUsd)]))}
      <h2>Who beat us</h2>
      ${table(["Bot", "Times"], p.takers.map((r) => [`<span class="mono">${esc(r.bot)}</span>`, String(r.count)]), "Nobody yet")}</div>
  </div>
  <div class="two" style="margin-top:14px">
    <div class="card"><h2 style="margin-top:0">By strategy</h2>
      ${statsTable(p.byKind, "Strategy", "Nothing yet")}
      <h2>Block vs Flashblock reaction</h2>
      ${statsTable(p.byStage, "Found on", "Nothing yet")}</div>
    <div class="card"><h2 style="margin-top:0">Route win rates (verified only)</h2>
      ${statsTable(p.scores, "Route", "No verified route has been decided yet")}</div>
  </div>
  ${liquidationSection(liq, meta.borrowersWatched)}

  <h2>The Base MEV market today</h2>
  <div class="tiles">
    ${statTile("Arbitrage transactions", String(m.arbitrageTxs), `${usd(m.arbitrageProfitUsd)} extracted (priced tokens only)`)}
    ${statTile("Sandwich attacks", String(m.sandwichTxs), `${usd(m.sandwichProfitUsd)} extracted`)}
    ${statTile("Active bots", String(m.bots.length >= 20 ? "20+" : m.bots.length), "with at least one detected MEV tx")}
  </div>
  <div class="card" style="margin-top:14px"><h2 style="margin-top:0">MEV transactions per hour (UTC)</h2>${hourlyChart(m.hourly)}</div>
  <div class="two" style="margin-top:14px">
    <div class="card"><h2 style="margin-top:0">Bot leaderboard</h2>
      ${table(["Bot", "Txs", "Arb", "Sandwich", "Profit", "Gas"], m.bots.map((b) => [`<span class="mono">${esc(short(b.bot))}</span>`, String(b.txs), String(b.arbitrage), String(b.sandwich), usd(b.profitUsd) + (b.unpricedTxs ? "*" : ""), b.costUsd ? usd(b.costUsd) : "–"]))}
      <p class="empty">* some transactions could not be priced in USD (no known route to WETH/USDC).</p></div>
    <div class="card"><h2 style="margin-top:0">Most arbed pairs</h2>
      ${table(["Pair", "Txs", "Profit"], m.topPairs.map((r) => [esc(r.pair), String(r.txs), usd(r.profitUsd)]))}
      <h2>DEX combinations</h2>
      ${table(["DEXes", "Txs", "Profit"], m.topDexRoutes.map((r) => [esc(r.route), String(r.txs), usd(r.profitUsd)]))}</div>
  </div>
  ${m.watched.length ? `<div class="card" style="margin-top:14px"><h2 style="margin-top:0">Watched bots</h2>${table(["Bot", "Txs", "Arb", "Sandwich", "Profit", "Last block"], m.watched.map((b) => [`<span class="mono">${esc(b.bot)}</span>`, String(b.txs), String(b.arbitrage), String(b.sandwich), usd(b.profitUsd), String(b.lastSeenBlock)]))}</div>` : ""}

  <footer>Generated ${esc(new Date().toISOString())} by base-arb-bot. Profit figures are from Swap-event net flows; "realistic" paper P&amp;L only counts opportunities still open at the next block, priced at that block.</footer>
</main>
</body>
</html>`;
}

export function writeReport(dir: string, day: string, html: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day}.html`);
  writeFileSync(file, html);
  writeFileSync(join(dir, "latest.html"), html);
  return file;
}
