/**
 * Turns data/fleet/xchain-spreads.jsonl into the JSON the terminal's "Cross-chain spreads" table
 * needs (ui/terminal.html, #spreads). The integrator wires summarize() into /api later; until then
 * it also runs on its own:
 *
 *   node bots/xchain-monitor/summary.ts [path/to/xchain-spreads.jsonl] > spreads.json
 *
 * A "window" is a run of consecutive open checks for the same asset and chain pair. A gap of more
 * than 3 check intervals with no data ends a run.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpreadRecord } from "./spreads.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface SpreadRow {
  asset: string;
  /** terminal network ids: base, arb, op, eth */
  a: string;
  b: string;
  route: string;
  buyOn: string;
  sellOn: string;
  gapBps: number;
  costBps: number;
  netBps: number;
  open: boolean;
  /** 24 hourly averages of the gap in bps, oldest first; null for an hour with no checks */
  hist24h: (number | null)[];
  windowsToday: number;
  windows24h: number;
  bestWindow: { netBps: number; gapBps: number; at: string } | null;
  /** USD per $10k at today's best window and at the current check (0 when net <= 0) */
  estUsdPer10k: number;
  estUsdPer10kNow: number;
  checks24h: number;
  lastAt: string;
}

export interface SpreadSummary {
  generatedAt: string;
  rows: SpreadRow[];
  totals: { openNow: number; openWindows24h: number; windowsToday: number; bestNetBps: number | null; checks24h: number };
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Parse one JSONL line; null for anything that isn't a well-formed record. */
export function parseRecord(line: string): SpreadRecord | null {
  if (!line.trim()) return null;
  try {
    const o = JSON.parse(line) as Partial<SpreadRecord>;
    if (typeof o.asset !== "string" || typeof o.a !== "string" || typeof o.b !== "string") return null;
    if (typeof o.ts !== "string" || !Number.isFinite(Date.parse(o.ts))) return null;
    for (const k of ["gapBps", "costBps", "netBps"] as const) if (typeof o[k] !== "number" || !Number.isFinite(o[k])) return null;
    return o as SpreadRecord;
  } catch {
    return null;
  }
}

/** Read every record newer than sinceMs from a JSONL file (missing file = no records). */
export async function loadRecords(path: string, sinceMs: number): Promise<SpreadRecord[]> {
  if (!existsSync(path)) return [];
  const out: SpreadRecord[] = [];
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const r = parseRecord(line);
    if (r && Date.parse(r.ts) >= sinceMs) out.push(r);
  }
  return out;
}

/**
 * Summarise records (any order) as of `now`. `intervalMs` is the monitor's check interval, used to
 * tell a paused monitor from a closed window.
 */
export function summarize(records: SpreadRecord[], now: Date, intervalMs = 15_000): SpreadSummary {
  const t = now.getTime();
  const since = t - DAY;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const groups = new Map<string, SpreadRecord[]>();
  for (const r of records) {
    const ts = Date.parse(r.ts);
    if (ts < since || ts > t + 60_000) continue;
    const k = `${r.asset}|${r.a}|${r.b}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }
  const rows: SpreadRow[] = [];
  for (const g of groups.values()) {
    g.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
    const last = g[g.length - 1]!;
    const sums = new Array<number>(24).fill(0);
    const counts = new Array<number>(24).fill(0);
    let windows24h = 0;
    let windowsToday = 0;
    let best: SpreadRow["bestWindow"] = null;
    let prevOpen = false;
    let prevTs = -Infinity;
    for (const r of g) {
      const ts = Date.parse(r.ts);
      const h = Math.min(23, Math.max(0, 23 - Math.floor((t - ts) / HOUR)));
      sums[h]! += r.gapBps;
      counts[h]! += 1;
      const continues = prevOpen && ts - prevTs <= 3 * intervalMs;
      if (r.open && !continues) {
        windows24h++;
        if (ts >= dayStart) windowsToday++;
      }
      if (r.open && ts >= dayStart && (!best || r.netBps > best.netBps)) best = { netBps: r.netBps, gapBps: r.gapBps, at: r.ts };
      prevOpen = r.open;
      prevTs = ts;
    }
    rows.push({
      asset: last.asset,
      a: last.a,
      b: last.b,
      route: `${last.a}↔${last.b}`,
      buyOn: last.buyOn,
      sellOn: last.sellOn,
      gapBps: last.gapBps,
      costBps: last.costBps,
      netBps: last.netBps,
      open: last.open && t - Date.parse(last.ts) <= 3 * intervalMs,
      hist24h: sums.map((s, i) => (counts[i] ? r2(s / counts[i]!) : null)),
      windowsToday,
      windows24h,
      bestWindow: best,
      estUsdPer10k: best ? r2(Math.max(0, (best as { netBps: number }).netBps)) : 0, // 1 bps of $10k = $1
      estUsdPer10kNow: r2(Math.max(0, last.netBps)),
      checks24h: g.length,
      lastAt: last.ts,
    });
  }
  rows.sort((x, y) => y.netBps - x.netBps || x.asset.localeCompare(y.asset) || x.route.localeCompare(y.route));
  const all = records.filter((r) => Date.parse(r.ts) >= since && Date.parse(r.ts) <= t + 60_000);
  return {
    generatedAt: now.toISOString(),
    rows,
    totals: {
      openNow: rows.filter((r) => r.open).length,
      openWindows24h: rows.reduce((s, r) => s + r.windows24h, 0),
      windowsToday: rows.reduce((s, r) => s + r.windowsToday, 0),
      bestNetBps: all.length ? all.reduce((m, r) => Math.max(m, r.netBps), -Infinity) : null,
      checks24h: all.length,
    },
  };
}

// CLI: node bots/xchain-monitor/summary.ts [file]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = resolve(process.argv[2] ?? "data/fleet/xchain-spreads.jsonl");
  const now = new Date();
  loadRecords(file, now.getTime() - DAY)
    .then((recs) => process.stdout.write(JSON.stringify(summarize(recs, now), null, 2) + "\n"))
    .catch((e) => {
      process.stderr.write(`summary failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
