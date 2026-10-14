/**
 * Passive cross-chain spread monitor (fleet id: xchain-monitor, detect mode only).
 *
 * Every ~15 s: read WETH/USDC and USDC/USDT from the deepest verified pool on Base, Arbitrum,
 * Optimism and Ethereum (eth_call slot0), compute the gap for every chain pair, subtract a
 * configurable bridge + gas + swap-fee cost, append one line per (asset, pair) to
 * data/fleet/xchain-spreads.jsonl and refresh the wrapper's metrics file.
 *
 * It never signs, sends, trades or bridges: the only RPC methods it can issue are eth_chainId,
 * eth_getCode and eth_call (enforced in rpc.ts). RPC URLs come from BASE_RPC_URL, ARB_RPC_URL,
 * OP_RPC_URL and ETH_RPC_URL and are never logged or written anywhere.
 *
 *   node bots/xchain-monitor/monitor.ts            run until stopped
 *   node bots/xchain-monitor/monitor.ts --once     one check, then exit
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { httpTransport, redact } from "./rpc.ts";
import type { RpcTransport } from "./rpc.ts";
import { checkChainId, readPrices, resolvePools } from "./pools.ts";
import type { Pool } from "./pools.ts";
import { computeChecks } from "./spreads.ts";
import type { MonitorCfg, SpreadRecord } from "./spreads.ts";
import { loadRecords, summarize } from "./summary.ts";

export const VERSION = "xchain-monitor 0.1";
const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MonitorCfg {
  const path = env.XCHAIN_CONFIG ? resolve(env.XCHAIN_CONFIG) : join(HERE, "config.json");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as MonitorCfg;
  const num = (v: string | undefined, d: number, lo: number, hi: number): number => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  cfg.intervalMs = num(env.XCHAIN_INTERVAL_MS, cfg.intervalMs, 5_000, 600_000);
  cfg.notionalUsd = num(env.XCHAIN_NOTIONAL_USD, cfg.notionalUsd, 100, 10_000_000);
  cfg.minNetBps = num(env.XCHAIN_MIN_NET_BPS, cfg.minNetBps, -1_000, 1_000);
  if (env.XCHAIN_OUT_DIR) cfg.outDir = env.XCHAIN_OUT_DIR;
  return cfg;
}

interface ChainState {
  id: string;
  rpc: RpcTransport | null;
  pools: Pool[];
  lastResolve: number;
  up: boolean;
  errors: number;
  note: string;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export class Monitor {
  readonly cfg: MonitorCfg;
  readonly chains: ChainState[];
  readonly spreadsPath: string;
  readonly metricsPath: string;
  records: SpreadRecord[] = [];
  last: SpreadRecord[] = [];
  private log: (s: string) => void;

  constructor(cfg: MonitorCfg, transports: Record<string, RpcTransport | null>, opts: { log?: (s: string) => void } = {}) {
    this.cfg = cfg;
    this.log = opts.log ?? ((s) => console.log(`${new Date().toISOString()} ${s}`));
    this.spreadsPath = resolve(cfg.outDir, cfg.spreadsFile);
    this.metricsPath = resolve(cfg.outDir, cfg.metricsFile);
    this.chains = Object.keys(cfg.chains).map((id) => ({
      id,
      rpc: transports[id] ?? null,
      pools: [],
      lastResolve: 0,
      up: false,
      errors: 0,
      note: transports[id] ? "not resolved yet" : `${cfg.chains[id]!.rpcEnv} not set`,
    }));
  }

  /** Transports from the environment: one per chain whose RPC env var is set. */
  static transportsFromEnv(cfg: MonitorCfg, env: NodeJS.ProcessEnv = process.env): Record<string, RpcTransport | null> {
    const out: Record<string, RpcTransport | null> = {};
    for (const [id, c] of Object.entries(cfg.chains)) {
      const url = (env[c.rpcEnv] ?? "").trim();
      out[id] = /^https?:\/\//i.test(url) ? httpTransport(url) : null;
    }
    return out;
  }

  async loadHistory(now: Date): Promise<void> {
    this.records = await loadRecords(this.spreadsPath, now.getTime() - DAY);
  }

  private async resolveChain(c: ChainState, now: number): Promise<void> {
    if (!c.rpc) return;
    c.lastResolve = now;
    try {
      const chain = this.cfg.chains[c.id]!;
      await checkChainId(c.rpc, chain.chainId);
      const { pools, notes } = await resolvePools(c.rpc, c.id, chain, this.cfg.assets);
      c.pools = pools;
      for (const n of notes) this.log(`resolve ${n}`);
      for (const p of pools)
        this.log(
          `resolve ${c.id}: ${p.asset} -> ${p.venue} ${p.address} (tier ${p.tier}, fee ${p.feeBps}bps, L=${p.liquidity}` +
            (p.matchesExpected === false ? ", differs from the expected pool in config" : "") +
            ")",
        );
      c.note = pools.length ? `${pools.length} pools verified` : "no verified pools";
    } catch (e) {
      c.pools = [];
      c.errors++;
      c.note = redact(e instanceof Error ? e.message : String(e));
      this.log(`resolve ${c.id} failed: ${c.note}`);
    }
  }

  /** One check across every chain. Returns the records it appended. */
  async tick(now: Date = new Date()): Promise<SpreadRecord[]> {
    const t = now.getTime();
    const resolveMs = this.cfg.resolveEveryMin * 60_000;
    const prices = new Map<string, number>();
    const pools = new Map<string, Pool>();
    await Promise.all(
      this.chains.map(async (c) => {
        if (!c.rpc) return;
        const retryEmpty = c.pools.length === 0 && t - c.lastResolve >= 4 * this.cfg.intervalMs;
        if (c.lastResolve === 0 || t - c.lastResolve >= resolveMs || retryEmpty) await this.resolveChain(c, t);
        if (c.pools.length === 0) {
          c.up = false;
          return;
        }
        try {
          const px = await readPrices(c.rpc, c.pools);
          c.pools.forEach((p, i) => {
            const v = px[i]!;
            if (Number.isFinite(v) && v > 0) {
              prices.set(`${c.id}|${p.asset}`, v);
              pools.set(`${c.id}|${p.asset}`, p);
            }
          });
          c.up = true;
        } catch (e) {
          c.up = false;
          c.errors++;
          c.note = redact(e instanceof Error ? e.message : String(e));
          this.log(`read ${c.id} failed: ${c.note}`);
        }
      }),
    );
    const recs = computeChecks(this.cfg, pools, prices, now);
    if (recs.length) this.append(recs);
    this.last = recs;
    this.records.push(...recs);
    this.records = this.records.filter((r) => Date.parse(r.ts) >= t - DAY);
    this.writeMetrics(now);
    return recs;
  }

  private append(recs: SpreadRecord[]): void {
    mkdirSync(dirname(this.spreadsPath), { recursive: true });
    try {
      if (existsSync(this.spreadsPath) && statSync(this.spreadsPath).size > this.cfg.maxFileMb * 1_048_576) {
        renameSync(this.spreadsPath, this.spreadsPath.replace(/\.jsonl$/, ".1.jsonl"));
      }
    } catch {
      /* rotation is best-effort */
    }
    appendFileSync(this.spreadsPath, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  /** The wrapper's metrics file (bots/CONTRACT.md): never any PnL, sends or gas, this bot doesn't trade. */
  metrics(now: Date): Record<string, unknown> {
    const s = summarize(this.records, now, this.cfg.intervalMs);
    const live = this.chains.filter((c) => c.up).length;
    const best = s.rows[0];
    const down = this.chains.filter((c) => !c.up).map((c) => `${c.id}: ${c.note}`);
    const detail =
      `${live}/${this.chains.length} chains live, ${s.rows.length} routes, ${s.totals.openNow} windows open` +
      (best ? `; best ${best.asset} ${best.route} gap ${best.gapBps}bps net ${best.netBps}bps` : "") +
      (down.length ? `; ${down.join("; ")}` : "");
    return {
      pnlUsd: 0,
      sends: 0,
      gasUsd: 0,
      detail: detail.slice(0, 300),
      version: VERSION,
      updatedAt: now.toISOString(),
      routes: s.rows.slice(0, 12).map((r) => ({
        pair: r.asset,
        venues: [r.a, r.b],
        count: r.windows24h,
        usd: r.estUsdPer10kNow,
        gapBps: r.gapBps,
        netBps: r.netBps,
      })),
      metrics: {
        openWindows24h: s.totals.openWindows24h,
        bestNetBps: s.totals.bestNetBps ?? 0,
        openNow: s.totals.openNow,
        windowsToday: s.totals.windowsToday,
        bestGapBpsNow: s.rows.reduce((m, r) => Math.max(m, r.gapBps), 0),
        chainsLive: live,
        chainsConfigured: this.chains.filter((c) => c.rpc).length,
        poolsVerified: this.chains.reduce((n, c) => n + c.pools.length, 0),
        checks24h: s.totals.checks24h,
        rpcErrors: this.chains.reduce((n, c) => n + c.errors, 0),
        notionalUsd: this.cfg.notionalUsd,
      },
    };
  }

  writeMetrics(now: Date): void {
    writeJsonAtomic(this.metricsPath, this.metrics(now));
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const transports = Monitor.transportsFromEnv(cfg);
  const m = new Monitor(cfg, transports);
  const set = m.chains.filter((c) => c.rpc).map((c) => c.id);
  console.log(`${VERSION}: detect only, never trades or bridges; chains with an RPC: ${set.join(", ") || "none"} (every ${cfg.intervalMs / 1000}s)`);
  await m.loadHistory(new Date());
  if (process.argv.includes("--once")) {
    const recs = await m.tick();
    for (const r of recs) console.log(`${r.asset} ${r.a}↔${r.b} gap ${r.gapBps}bps cost ${r.costBps}bps net ${r.netBps}bps ${r.open ? "OPEN" : "closed"}`);
    return;
  }
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopped) {
    const started = Date.now();
    try {
      await m.tick();
    } catch (e) {
      console.log(`tick failed: ${redact(e instanceof Error ? e.message : String(e))}`);
    }
    const wait = Math.max(1_000, cfg.intervalMs - (Date.now() - started));
    for (let waited = 0; waited < wait && !stopped; waited += 250) await new Promise((r) => setTimeout(r, 250));
  }
  console.log("stopped");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`xchain-monitor failed: ${redact(e instanceof Error ? e.message : String(e))}`);
    process.exitCode = 1;
  });
}
