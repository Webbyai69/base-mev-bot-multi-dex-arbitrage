#!/usr/bin/env node
/**
 * night_watch.mjs: a read-only snapshot of the Base arb bot for the overnight
 * learning agent (and for anyone who wants the numbers fast).
 *
 * Reads the bot's own records and logs and prints one Markdown report. With
 * --record it also appends one line of numbers to history.jsonl, so trends
 * survive between runs.
 *
 * It never writes inside the bot folder, never opens .env or any key file,
 * never uses the network and never starts or stops anything. It uses the
 * bot's own compiled analytics (dist/command), so its numbers match /terminal.
 *
 *   node night_watch.mjs                       last 3 hours
 *   node night_watch.mjs --hours 8 --record    last 8 hours, and log the numbers
 *   node night_watch.mjs --simulate '{"minProfitUsd":0.2,"gasX":1,"latencyCutMs":0,"gapMs":250,"hours":24}'
 *
 * Where it looks: BOT_DIR if set; else the repo it sits in (tools/night-watch
 * inside the bot); else a base-arb-bot folder next to it (the deployed copy in
 * base-arb-watch). history.jsonl goes to WATCH_DIR if set, else beside this file.
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const insideRepo = existsSync(join(REPO, "package.json")) && existsSync(join(REPO, "src", "command"));
const BOT = resolve(process.env.BOT_DIR || (insideRepo ? REPO : join(HERE, "..", "base-arb-bot")));
const WATCH = resolve(process.env.WATCH_DIR || HERE);
const DATA = join(BOT, "data");
const REPORTS = join(BOT, "reports");
const HOURS = Math.min(168, Math.max(0.25, Number(opt("--hours", "3")) || 3));
const NOW = Date.now();
const SINCE = NOW - HOURS * 3_600_000;
const MB = 1024 * 1024;

// ---------- helpers ----------
const quant = (xs, p) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
};
const usd = (n) => (n == null || !Number.isFinite(n) ? "–" : `$${Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2)}`);
const fx = (n, d = 0) => (n == null || !Number.isFinite(n) ? "–" : n.toFixed(d));
const short = (a) => (typeof a === "string" && a.startsWith("0x") ? a.slice(0, 10) : String(a ?? "?"));
const ts = (s) => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
};
const inWin = (s) => ts(s) >= SINCE;
const ago = (ms) => (!Number.isFinite(ms) ? "?" : ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const mtime = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

function tailText(file, bytes) {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    let s = buf.toString("utf8");
    if (start > 0) s = s.slice(s.indexOf("\n") + 1);
    return s;
  } catch {
    return "";
  }
}
function jsonl(file, bytes) {
  const rows = [];
  for (const line of tailText(file, bytes).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      /* partial or bad line */
    }
  }
  return rows;
}
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const lines = [];
const out = (s = "") => lines.push(s);
const table = (head, rows) => {
  if (!rows.length) return;
  out(`| ${head.join(" | ")} |`);
  out(`|${head.map(() => "---").join("|")}|`);
  for (const r of rows) out(`| ${r.join(" | ")} |`);
  out();
};

// ---------- the bot's own analytics code (same maths as /terminal) ----------
let R = null;
let T = null;
let modErr = "";
try {
  R = await import(pathToFileURL(join(BOT, "dist", "command", "records.js")).href);
  T = await import(pathToFileURL(join(BOT, "dist", "command", "telemetry.js")).href);
} catch (e) {
  modErr = String(e?.message ?? e).slice(0, 200);
}

// ---------- records ----------
const oppRecs = jsonl(join(DATA, "opportunities.jsonl"), 16 * MB);
const mevRecs = jsonl(join(DATA, "mev.jsonl"), 24 * MB);
const liveRecs = jsonl(join(DATA, "live.jsonl"), 2 * MB);
const opps = oppRecs.filter((r) => r.kind === "opportunity");
const outcomes = new Map(oppRecs.filter((r) => r.kind === "outcome").map((r) => [r.id, r]));
const liveById = new Map(); // a "pending" line, then the final one, per send
for (const r of liveRecs) if (r.id !== undefined && typeof r.sentAt === "string") liveById.set(r.id, r);
const lives = [...liveById.values()];
const mevByTx = new Map(mevRecs.filter((m) => m.txHash).map((m) => [String(m.txHash).toLowerCase(), m]));

// ---------- simulator mode ----------
if (has("--simulate")) {
  if (!R || !T) {
    console.log(`Simulator unavailable: ${modErr || "dist/command not found (build the bot first)"}`);
    process.exit(0);
  }
  let cfg = {};
  try {
    cfg = JSON.parse(opt("--simulate", "{}"));
  } catch {
    console.log("--simulate needs a JSON object, for example '{\"minProfitUsd\":0.2,\"gasX\":0.5}'");
    process.exit(0);
  }
  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const hours = clamp(cfg.hours, 1, 168, 24);
  const since = NOW - hours * 3_600_000;
  const oppL = opps.filter((o) => ts(o.foundAt) >= since).map(R.toOpp).filter(Boolean);
  const outL = [...outcomes.values()].map(R.toOutcome).filter(Boolean);
  const base = { minProfitUsd: 0.1, gasX: 1, latencyCutMs: 0, gapMs: 250, excludeDexes: [] };
  const run = {
    minProfitUsd: clamp(cfg.minProfitUsd, 0, 1000, base.minProfitUsd),
    gasX: clamp(cfg.gasX, 0.1, 10, 1),
    latencyCutMs: clamp(cfg.latencyCutMs, 0, 2000, 0),
    gapMs: clamp(cfg.gapMs, 1, 5000, 250),
    excludeDexes: Array.isArray(cfg.excludeDexes) ? cfg.excludeDexes.slice(0, 20).map(String) : [],
  };
  console.log(JSON.stringify({ hours, finds: oppL.length, result: T.simulate(oppL, outL, run), baseline: T.simulate(oppL, outL, { ...base, gapMs: run.gapMs }) }, null, 2));
  console.log("Modelled replay of recorded finds, not a forecast. Few finds = low confidence.");
  process.exit(0);
}

// ---------- our own addresses (public), from the bot's startup lines ----------
let reportFiles = [];
try {
  reportFiles = readdirSync(REPORTS);
} catch {
  /* no reports folder */
}
const runLogs = reportFiles.filter((f) => /^run-.*\.log$/.test(f)).sort();
const outLogs = runLogs.filter((f) => !f.endsWith(".err.log"));
const errLogs = runLogs.filter((f) => f.endsWith(".err.log"));
const self = new Set();
for (const f of errLogs.slice(-4)) {
  for (const l of tailText(join(REPORTS, f), 2 * MB).split("\n")) {
    if (!l.includes("LIVE")) continue;
    for (const m of l.matchAll(/0x[0-9a-fA-F]{40}\b/g)) self.add(m[0].toLowerCase());
  }
}

// ---------- logs in the window ----------
const LINE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?)\s+(INFO|WARN|ERROR|DEBUG)\s+(.*)$/;
const norm = (m) =>
  m
    .replace(/0x[0-9a-fA-F]{6,}/g, "0x…")
    .replace(/\d+(\.\d+)?/g, "#")
    .slice(0, 120);
const blocksByLog = new Map(); // one entry per bot run (log file)
const groups = new Map();
let starts = 0;
let watchAdds = 0;
let liveSentLines = 0;
let notSending = 0;
let liqLines = 0;
let lastBlock = null;
let fbLast = null;
let rpcLast = null;
let borrowersLast = null;
let uptimeLast = null;
const windowLogs = [...outLogs, ...errLogs].map((f) => join(REPORTS, f)).filter((p) => mtime(p) >= SINCE);
for (const p of windowLogs) {
  const isErr = p.endsWith(".err.log");
  for (const raw of tailText(p, 12 * MB).split("\n")) {
    const m = LINE.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    const t = Date.parse(`${m[1]}T${m[2]}Z`); // the bot logs in UTC
    if (!(t >= SINCE)) continue;
    const level = m[3];
    const msg = m[4];
    if (!isErr && msg.startsWith("block ")) {
      const b = /^block (\d+): (\d+) pools, (\d+) opps, (\d+) mev txs, (\d+)ms/.exec(msg);
      if (b) {
        if (!blocksByLog.has(p)) blocksByLog.set(p, []);
        blocksByLog.get(p).push({ t, n: +b[1], pools: +b[2], opps: +b[3], ms: +b[5] });
        if (!lastBlock || t > lastBlock.t) lastBlock = { t, n: +b[1], pools: +b[2] };
        const fb = /flashblocks (\d+) scans\/(\d+) opps/.exec(msg);
        if (fb) fbLast = { scans: +fb[1], opps: +fb[2] };
        const rp = /rpc (\d+) calls \(~([\d.]+)M Alchemy CU\/day/.exec(msg);
        if (rp) rpcLast = { calls: +rp[1], cuPerDayM: +rp[2] };
        const bo = /(\d+) borrowers/.exec(msg);
        if (bo) borrowersLast = +bo[1];
        const up = /uptime (\S+)/.exec(msg);
        if (up) uptimeLast = up[1];
      }
      continue;
    }
    if (msg.startsWith("watch list: added")) watchAdds++;
    if (/^live: sent/.test(msg)) liveSentLines++;
    if (/not sending/.test(msg)) notSending++;
    if (/liquidat/i.test(msg) && !/^LIVE/.test(msg)) liqLines++;
    if (/^LIVE( MODE)?:/.test(msg)) {
      // Startup banner lines: expected, so count bot starts instead of listing them.
      if (/^LIVE: setup checks out/.test(msg)) starts++;
      continue;
    }
    if (level === "WARN" || level === "ERROR") {
      const k = `${level} ${norm(msg)}`;
      const g = groups.get(k) ?? { level, n: 0, sample: msg.slice(0, 160), last: t };
      g.n++;
      g.last = t;
      groups.set(k, g);
    }
  }
}
const newestLog = outLogs.map((f) => join(REPORTS, f)).sort((a, b) => mtime(b) - mtime(a))[0] ?? null;
const logAgeMs = newestLog ? NOW - mtime(newestLog) : NaN;
const blocks = (newestLog && blocksByLog.get(newestLog)) || []; // the current run only
const ms = blocks.map((b) => b.ms);
const alive = Number.isFinite(logAgeMs) && logAgeMs < 5 * 60_000;

// ---------- status, STOP, digest ----------
const status = tailText(join(REPORTS, "run-24h.status.txt"), 4096).replace(/^\uFEFF/, "").trim().replace(/\s*\n\s*/g, " · ");
const stopPath = join(DATA, "STOP");
const stop = existsSync(stopPath) ? tailText(stopPath, 2048).trim().slice(0, 300) || "(empty STOP file)" : null;
const digest = tailText(join(REPORTS, "digest-latest.md"), 512 * 1024);
const dg = { funnel: [] };
{
  const g = /Generated (\S+)/.exec(digest);
  if (g) dg.generated = g[1];
  const mode = /mode \*\*(\w+)\*\*/.exec(digest);
  if (mode) dg.mode = mode[1];
  const st = /## Live trading\s*\n+([^\n]+)/.exec(digest);
  if (st) dg.liveState = st[1].trim();
  const gas = /Gas today \$([\d.]+) of the \$([\d.]+) daily limit; failed sends in a row (\d+) of (\d+)/.exec(digest);
  if (gas) Object.assign(dg, { gasToday: +gas[1], gasCap: +gas[2], failsInRow: +gas[3], failLimit: +gas[4] });
  dg.funnel = [...digest.matchAll(/^\| ([A-Z_]+) \| [^|]+\| (\d+) \| ([\d.]+)% \|/gm)].map((x) => ({ code: x[1], n: +x[2], pct: +x[3] }));
  const dash = /## Settings changed on the dashboard\s*\n+([^\n]+)/.exec(digest);
  if (dash) dg.dashboard = dash[1].trim();
  const liq = /## Aave V3 liquidations[^\n]*\n+([\s\S]*?)\n## /.exec(digest);
  if (liq) dg.liq = liq[1].replace(/\s+/g, " ").trim().slice(0, 240);
}

// ---------- pools ----------
const poolsJson = readJson(join(DATA, "pools.json"));
const watched = new Set((poolsJson?.pools ?? []).map((p) => String(p.address).toLowerCase()));
const sym = new Map((poolsJson?.tokens ?? []).map((t) => [String(t.address).toLowerCase(), t.symbol]));
const tokenName = (a) => sym.get(String(a).toLowerCase()) ?? short(a);
const byDex = {};
for (const p of poolsJson?.pools ?? []) byDex[p.dex] = (byDex[p.dex] ?? 0) + 1;

// ================= report =================
out(`# Night watch · ${new Date(NOW).toISOString().slice(0, 16)}Z · last ${HOURS} h`);
out();
out("## Is it running?");
out(`- Bot log: ${newestLog ? newestLog.split(/[\\/]/).at(-1) : "none"}, last written ${ago(logAgeMs)} ago → **${alive ? "running" : "LOOKS STOPPED"}**`);
out(`- Status file: ${status || "missing"}`);
if (lastBlock) out(`- Last block line: ${lastBlock.n} at ${new Date(lastBlock.t).toISOString().slice(11, 19)}Z, ${lastBlock.pools} pools, uptime ${uptimeLast ?? "?"}`);
out(`- STOP file: ${stop ? `**PRESENT**: ${stop}` : "none"}`);
if (dg.generated) out(`- Digest: generated ${ago(NOW - ts(dg.generated))} ago, mode ${dg.mode ?? "?"}. ${dg.liveState ?? ""}`);
if (dg.dashboard) out(`- Dashboard changes in force: ${dg.dashboard}`);
out();

out("## Block loop (sampled block lines, one row per bot run in the window; Base makes a block every 2 s)");
table(
  ["run (log)", "samples", "p50 ms", "p90 ms", "max ms", "over 2 s", "pools"],
  [...blocksByLog].map(([p, bs]) => {
    const v = bs.map((b) => b.ms);
    return [p.split(/[\\/]/).at(-1) + (p === newestLog ? " (current)" : ""), bs.length, fx(quant(v, 0.5)), fx(quant(v, 0.9)), fx(Math.max(...v)), v.filter((x) => x > 2000).length, bs.at(-1).pools];
  }),
);
if (!blocksByLog.size) out("_No block lines in the window._\n");
out(`Current run since start: flashblock scans / opps ${fbLast ? `${fbLast.scans} / ${fbLast.opps}` : "–"} · Aave borrowers watched ${borrowersLast ?? "–"} · RPC ${rpcLast ? `${rpcLast.calls} calls, ~${rpcLast.cuPerDayM}M Alchemy CU/day at this pace` : "–"}`);
out(`In the window: bot starts ${starts} · watch-list adds ${watchAdds} · live "sent" lines ${liveSentLines} · "not sending" (gas cap) lines ${notSending} · liquidation lines ${liqLines}`);
out();

const warnRows = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 10);
out("## Warnings and errors in the window");
if (warnRows.length) table(["level", "count", "last (UTC)", "example"], warnRows.map((g) => [g.level, g.n, new Date(g.last).toISOString().slice(11, 19), g.sample.replace(/\|/g, "/")]));
else out("_None._\n");

// ---------- live sends ----------
const liveStats = (rows) => {
  const s = { sent: rows.length, landed: 0, reverted: 0, dropped: 0, pending: 0, gas: 0, landedProfit: 0 };
  for (const r of rows) {
    if (r.status === "success") {
      s.landed++;
      s.landedProfit += Number(r.expectedProfitUsd) || 0;
    } else if (r.status === "reverted") s.reverted++;
    else if (r.status === "dropped") s.dropped++;
    else s.pending++;
    s.gas += Number(r.gasUsd) || 0;
  }
  return s;
};
const lw = liveStats(lives.filter((r) => inWin(r.sentAt)));
const la = liveStats(lives);
out("## Live sends");
if (dg.gasCap !== undefined) out(`Gas today (UTC day) ${usd(dg.gasToday)} of ${usd(dg.gasCap)} · failed sends in a row ${dg.failsInRow} of ${dg.failLimit} (from the digest).`);
out();
table(
  ["", "sent", "landed", "reverted", "dropped", "pending", "gas paid", "expected profit of landed"],
  [
    ["window", lw.sent, lw.landed, lw.reverted, lw.dropped, lw.pending, usd(lw.gas), usd(lw.landedProfit)],
    ["all time", la.sent, la.landed, la.reverted, la.dropped, la.pending, usd(la.gas), usd(la.landedProfit)],
  ],
);
const lost = lives.filter((r) => r.status === "reverted" || r.status === "dropped").slice(-6);
if (lost.length) {
  out("Failed sends (newest last): who won and what they bid");
  table(
    ["sent (UTC)", "route", "expected", "our bid gwei", "found → mined (blocks)", "taken by", "their bid gwei", "their tx index"],
    lost.map((r) => {
      const o = opps.find((x) => x.id === r.id);
      const oc = outcomes.get(r.id);
      const tm = oc?.takenTx ? mevByTx.get(String(oc.takenTx).toLowerCase()) : undefined;
      const route = o ? `${o.pairSymbols} [${(o.route?.dexes ?? [o.buyDex, o.sellDex]).join(">")}]` : "?";
      return [
        String(r.sentAt).slice(5, 19).replace("T", " "),
        route,
        usd(Number(r.expectedProfitUsd)),
        fx(Number(r.priorityFeeGwei), 3),
        r.minedBlock && o ? `${o.block} → ${r.minedBlock} (+${r.minedBlock - o.block})` : "–",
        oc?.takenBy ? short(oc.takenBy) : oc?.status ?? "–",
        tm?.priorityGwei !== undefined ? fx(Number(tm.priorityGwei), 3) : "–",
        tm?.txIndex ?? "–",
      ];
    }),
  );
}

// ---------- finds ----------
const wo = opps.filter((o) => inWin(o.foundAt));
out("## Our finds in the window");
if (!wo.length) out("_No recorded finds in the window._\n");
else {
  const agg = new Map();
  for (const o of wo) {
    const k = `${o.stage ?? "block"} · ${o.hops ?? 2} hops`;
    const a = agg.get(k) ?? { n: 0, ok: 0, persisted: 0, taken: 0, closed: 0, best: -Infinity };
    a.n++;
    if (o.sim === "executor-ok") a.ok++;
    const st = outcomes.get(o.id)?.status;
    if (st && a[st] !== undefined) a[st]++;
    a.best = Math.max(a.best, Number(o.netUsd) || 0);
    agg.set(k, a);
  }
  table(["found on", "finds", "verified", "persisted", "taken", "closed", "best net"], [...agg].map(([k, a]) => [k, a.n, a.ok, a.persisted, a.taken, a.closed, usd(a.best)]));
  const byRoute = new Map();
  for (const o of wo) {
    const k = `${o.pairSymbols} [${(o.route?.dexes ?? [o.buyDex, o.sellDex]).join(">")}]`;
    const a = byRoute.get(k) ?? { n: 0, best: 0, st: { persisted: 0, taken: 0, closed: 0 } };
    a.n++;
    a.best = Math.max(a.best, Number(o.netUsd) || 0);
    const st = outcomes.get(o.id)?.status;
    if (st && a.st[st] !== undefined) a.st[st]++;
    byRoute.set(k, a);
  }
  table(["route", "finds", "best net", "persisted / taken / closed"], [...byRoute].sort((a, b) => b[1].best - a[1].best).slice(0, 8).map(([k, a]) => [k, a.n, usd(a.best), `${a.st.persisted} / ${a.st.taken} / ${a.st.closed}`]));
}

if (dg.funnel.length) {
  out("## Why candidates don't trade (digest, since the bot started)");
  table(["code", "count", "share"], dg.funnel.filter((f) => f.n > 0).map((f) => [f.code, f.n, `${f.pct}%`]));
}

// ---------- rivals and the routes we miss ----------
const rivals = mevRecs.filter((m) => m.kind === "mev" && m.type === "arbitrage" && inWin(m.timestamp) && !self.has(String(m.bot).toLowerCase()) && !self.has(String(m.sender).toLowerCase()));
const sandwiches = mevRecs.filter((m) => m.kind === "mev" && m.type === "sandwich" && inWin(m.timestamp));
const ourPoolsInWindow = new Set();
for (const o of wo) for (const p of [o.buyPool, o.sellPool, ...(o.route?.pools ?? [])]) if (p) ourPoolsInWindow.add(String(p).toLowerCase());
const clusters = new Map();
const coverUsd = { all: 0, some: 0, none: 0 };
let unknownVenueUsd = 0; // DEXes the bot can't name yet (forks it has no config for)
for (const m of rivals) {
  const pools = (m.pools ?? []).map((p) => String(p).toLowerCase());
  if ((m.dexes ?? []).some((d) => /^unknown/.test(d))) unknownVenueUsd += Number(m.profitUsd) || 0;
  if (!pools.length) continue;
  const key = [...pools].sort().join(",");
  const c = clusters.get(key) ?? { pools, n: 0, usd: 0, bots: new Map(), bids: [], dexes: new Set(), tokens: m.tokens ?? [] };
  c.n++;
  c.usd += Number(m.profitUsd) || 0;
  c.bots.set(m.bot, (c.bots.get(m.bot) ?? 0) + (Number(m.profitUsd) || 0));
  if (Number.isFinite(Number(m.priorityGwei))) c.bids.push(Number(m.priorityGwei));
  for (const d of m.dexes ?? []) c.dexes.add(d);
  clusters.set(key, c);
}
for (const c of clusters.values()) {
  c.watched = c.pools.filter((p) => watched.has(p)).length;
  c.ours = c.pools.some((p) => ourPoolsInWindow.has(p));
  const k = c.watched === c.pools.length ? "all" : c.watched > 0 ? "some" : "none";
  c.cover = k;
  coverUsd[k] += c.usd;
}
const rivalUsd = rivals.reduce((s, m) => s + (Number(m.profitUsd) || 0), 0);
out("## What other bots took in the window");
out(`${rivals.length} arbitrage trades by ${new Set(rivals.map((m) => m.bot)).size} bots, ${usd(rivalUsd)} in total. Of that, ${usd(coverUsd.all)} was on routes whose pools we all watch (a speed or search problem), ${usd(coverUsd.some)} on routes we partly watch, ${usd(coverUsd.none)} on routes we don't watch at all (a coverage problem). ${usd(unknownVenueUsd)} went through a DEX the bot can't name yet ("unknown-v2/v3": a fork with no config, so its pools can't be watched). Sandwiches seen: ${sandwiches.length} (never our strategy; context only).`);
out();
table(
  ["route", "venues", "trades", "taken", "top bot", "bid p50 gwei", "pools watched", "we found it"],
  [...clusters.values()]
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 10)
    .map((c) => {
      const top = [...c.bots].sort((a, b) => b[1] - a[1])[0];
      return [c.tokens.map(tokenName).join(">") || "?", [...c.dexes].join("+") || "?", c.n, usd(c.usd), top ? short(top[0]) : "?", fx(quant(c.bids, 0.5), 4), `${c.watched}/${c.pools.length}`, c.ours ? "yes" : "no"];
    }),
);

// ---------- the terminal's own views ----------
if (R && T) {
  const oppL = opps.map(R.toOpp).filter(Boolean);
  const outL = [...outcomes.values()].map(R.toOutcome).filter(Boolean);
  const liveL = lives.map(R.toLive).filter(Boolean);
  const mevL = mevRecs.map(R.toMev).filter(Boolean);
  try {
    const L = T.latency(oppL, liveL, NOW, Math.max(HOURS, 24));
    out(`## Terminal views (same maths as /terminal)`);
    out(`- Latency (24 h): detect p50 ${fx(L.detectP50)} ms / p90 ${fx(L.detectP90)} ms into the block; find→send p50 ${fx(L.sendP50)} ms; land p50 ${fx(L.landBlocksP50)} blocks after the gap (samples: detect ${L.samples.detect}, send ${L.samples.send}, land ${L.samples.land}).`);
    const K = T.leaks(oppL, outL, liveL, undefined, NOW, Math.max(HOURS, 6));
    out(`- Leaks (${K.windowHours} h): captured ${K.captured.n} (${usd(K.captured.usd)}), still there a block later ${K.persisted.n} (${usd(K.persisted.usd)}), lost the race ${K.lostRace.n} (${usd(K.lostRace.usd)}, ${K.lostRace.liveReverts} live reverts), closed ${K.closed.n}. Top takers: ${K.topTakers.slice(0, 3).map((x) => `${short(x.bot)} ×${x.n}`).join(", ") || "–"}.`);
    const RC = T.racers(mevL, outL, liveL, [...self], NOW, HOURS);
    out();
    table(
      ["rival bot", "trades", "$ / hour", "share", "median bid gwei", "median tx index", "took from us", "top route"],
      RC.rows.filter((r) => !r.you).slice(0, 6).map((r) => [short(r.bot), r.trades, usd(r.usdPerHour), `${Math.round(r.share * 100)}%`, fx(r.medianPriorityGwei, 4), fx(r.medianTxIndex), r.takesFromUs, (r.topRoute ?? "–").slice(0, 40)]),
    );
    const RS = T.routeScores(oppL, outL, NOW).slice(0, 6);
    if (RS.length) table(["our pair (24 h)", "score", "finds", "recoverable", "win rate", "gas share", "best route"], RS.map((r) => [r.pair, fx(r.score, 2), r.finds, usd(r.recoverableUsd), r.winRate == null ? "–" : `${Math.round(r.winRate * 100)}%`, `${Math.round(r.gasShare * 100)}%`, r.bestRoute.slice(0, 50)]));
  } catch (e) {
    out(`_Terminal views failed: ${String(e?.message ?? e).slice(0, 160)}_\n`);
  }
} else {
  out(`_Terminal views unavailable: ${modErr || "dist/command missing"}._\n`);
}

// ---------- pools, liquidations, fleet ----------
out("## Pools and other systems");
out(`- Watch list: ${watched.size} pools (${Object.entries(byDex).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${n}`).join(", ")}), list last saved ${poolsJson?.discoveredAt ?? "?"}. PancakeSwap V3 pools: ${byDex["pancakeswap-v3"] ?? 0}, Uniswap V4 pools: ${byDex["uniswap-v4"] ?? byDex["univ4"] ?? 0}.`);
if (dg.liq) out(`- Liquidations (digest): ${dg.liq}`);
let fleet = [];
try {
  fleet = readdirSync(join(DATA, "fleet")).filter((f) => f.endsWith(".heartbeat.json"));
} catch {
  /* no fleet yet */
}
out(`- Fleet heartbeats: ${fleet.length ? fleet.map((f) => {
  const h = readJson(join(DATA, "fleet", f)) ?? {};
  return `${f.replace(".heartbeat.json", "")} ${String(h.status ?? "?").slice(0, 12)}/${String(h.mode ?? "?").slice(0, 8)} ${ago(NOW - ts(h.updatedAt))} ago`;
}).join("; ") : "none installed yet"}`);
out(`- Our addresses excluded from rivals: ${[...self].map(short).join(", ") || "none found"}`);
out();

// ---------- history ----------
const HIST = join(WATCH, "history.jsonl");
const rec = {
  at: new Date(NOW).toISOString(),
  hours: HOURS,
  alive,
  logAgeS: Number.isFinite(logAgeMs) ? Math.round(logAgeMs / 1000) : null,
  stop: !!stop,
  blocks: { n: blocks.length, p50: quant(ms, 0.5), p90: quant(ms, 0.9), max: ms.length ? Math.max(...ms) : null, over2s: ms.filter((x) => x > 2000).length },
  pools: lastBlock?.pools ?? watched.size,
  watchAdds,
  fb: fbLast,
  cuPerDayM: rpcLast?.cuPerDayM ?? null,
  finds: { n: wo.length, flashblock: wo.filter((o) => o.stage === "flashblock").length, verified: wo.filter((o) => o.sim === "executor-ok").length },
  live: { sent: lw.sent, landed: lw.landed, reverted: lw.reverted, dropped: lw.dropped, gasUsd: +lw.gas.toFixed(4) },
  gasToday: dg.gasToday ?? null,
  gasCap: dg.gasCap ?? null,
  failsInRow: dg.failsInRow ?? null,
  rivals: { arbs: rivals.length, usd: +rivalUsd.toFixed(2), watchedUsd: +coverUsd.all.toFixed(2), partUsd: +coverUsd.some.toFixed(2), unwatchedUsd: +coverUsd.none.toFixed(2), unknownVenueUsd: +unknownVenueUsd.toFixed(2) },
  starts,
  warn: [...groups.values()].filter((g) => g.level === "WARN").reduce((s, g) => s + g.n, 0),
  error: [...groups.values()].filter((g) => g.level === "ERROR").reduce((s, g) => s + g.n, 0),
};
const prev = jsonl(HIST, MB).slice(-6);
if (prev.length) {
  out("## Trend (earlier night-watch runs, newest last)");
  table(
    ["at (UTC)", "h", "running", "block p90 ms", "pools", "finds", "sent / landed", "rival $ (unwatched)", "CU/day"],
    [...prev, rec].map((h) => [String(h.at).slice(5, 16).replace("T", " "), h.hours, h.alive ? "yes" : "NO", fx(h.blocks?.p90), h.pools ?? "–", h.finds?.n ?? "–", `${h.live?.sent ?? 0} / ${h.live?.landed ?? 0}`, `${usd(h.rivals?.usd)} (${usd(h.rivals?.unwatchedUsd)})`, h.cuPerDayM == null ? "–" : `${h.cuPerDayM}M`]),
  );
}
if (has("--record")) {
  appendFileSync(HIST, JSON.stringify(rec) + "\n");
  out(`_Recorded this run in ${HIST.split(/[\\/]/).at(-1)}._`);
}
console.log(lines.join("\n"));
