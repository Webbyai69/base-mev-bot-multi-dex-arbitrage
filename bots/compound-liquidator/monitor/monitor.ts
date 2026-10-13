/**
 * Compound III (Comet) liquidation monitor, DETECT MODE ONLY. Clean-room code: only the
 * public Comet interface was read from compound-finance/comet; nothing is copied from it.
 *
 *   node bots/compound-liquidator/monitor/monitor.ts --mode detect [--once]
 *
 * What it does, per chain in COMPOUND_CHAINS (default base):
 *   1. checks every Comet market address has code and answers baseToken() (else drops it);
 *   2. discovers borrowers from Withdraw (src) and SupplyCollateral (dst) events, backfilling
 *      once and then following new blocks (state kept in data/fleet/compound-liquidator.state.json);
 *   3. every few blocks calls isLiquidatable for every borrower through Multicall3;
 *   4. for absorbable accounts reads their collateral, prices it, takes the protocol's discount
 *      from quoteCollateral, subtracts a swap cost and the gas of absorb + flash buy + swap;
 *   5. also prices collateral the protocol already holds and sells (no absorb needed);
 *   6. writes the fleet metrics file (bots/CONTRACT.md) and logs each new absorbable account.
 *
 * It never sends a transaction: there is no key, and the RPC client refuses every method that
 * is not a read (see rpc.ts).
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SEL, TOPIC, addressAt, call, decodeString, intAt, wordAt, type Call3 } from "./abi.ts";
import {
  buildMetrics,
  estimateAccount,
  estimateReserves,
  type AccountFind,
  type ChainSummary,
  type Estimate,
  type MarketView,
} from "./estimate.ts";
import { CHAINS, selectChains, type ChainDef, type MarketDef } from "./markets.ts";
import { Rpc } from "./rpc.ts";

export const VERSION = "compound-monitor 0.1";

interface StaticAsset {
  asset: string;
  feed: string;
  scale: bigint;
  symbol: string;
}

interface StaticMarket {
  def: MarketDef;
  base: string;
  baseSymbol: string;
  baseScale: bigint;
  baseFeed: string;
  assets: StaticAsset[];
}

export interface ChainState {
  lastBlock: number;
  borrowers: Record<string, string[]>;
}

export interface MonitorState {
  version: 1;
  chains: Record<string, ChainState>;
}

export interface CheckResult {
  summary: ChainSummary;
  finds: AccountFind[];
  reserves: { chain: string; market: string; e: Estimate }[];
}

const okWord = (r: { success: boolean; returnData: string }): boolean => r.success && r.returnData.length >= 66;

export class ChainWatcher {
  readonly def: ChainDef;
  readonly rpc: Rpc;
  markets: StaticMarket[] = [];
  borrowers = new Map<string, Set<string>>();
  lastBlock = 0;
  lastChecked = 0;
  ready = false;
  error: string | undefined;
  private chunk: number;
  private readonly swapCostBps: number;
  private readonly ethUsdFallback: number;
  private readonly log: (o: object) => void;

  constructor(def: ChainDef, rpc: Rpc, saved: ChainState | undefined, opts: { swapCostBps: number; ethUsdFallback: number; log: (o: object) => void }) {
    this.def = def;
    this.rpc = rpc;
    this.chunk = def.logChunk;
    this.swapCostBps = opts.swapCostBps;
    this.ethUsdFallback = opts.ethUsdFallback;
    this.log = opts.log;
    if (saved) {
      this.lastBlock = saved.lastBlock;
      for (const [k, v] of Object.entries(saved.borrowers)) this.borrowers.set(k, new Set(v.map((a) => a.toLowerCase())));
    }
  }

  /** Verify the chain and every market; keep only markets that answer like a Comet. */
  async init(): Promise<void> {
    const id = await this.rpc.chainId();
    if (id !== this.def.chainId) throw new Error(`RPC is chain ${id}, expected ${this.def.chainId}`);
    const kept: StaticMarket[] = [];
    for (const m of this.def.markets) {
      const code = await this.rpc.code(m.comet);
      if (!code || code === "0x") {
        this.log({ event: "market.dropped", chain: this.def.name, market: m.id, comet: m.comet, reason: "no code" });
        continue;
      }
      const r = await this.rpc.multicall([
        { target: m.comet, data: SEL.baseToken },
        { target: m.comet, data: SEL.baseTokenPriceFeed },
        { target: m.comet, data: SEL.baseScale },
        { target: m.comet, data: SEL.numAssets },
      ]);
      if (!r.every(okWord)) {
        this.log({ event: "market.dropped", chain: this.def.name, market: m.id, comet: m.comet, reason: "does not answer the Comet interface" });
        continue;
      }
      const base = addressAt(r[0]!.returnData, 0);
      const n = Number(wordAt(r[3]!.returnData, 0));
      const infos = await this.rpc.multicall(Array.from({ length: n }, (_, i) => ({ target: m.comet, data: call(SEL.getAssetInfo, i) })));
      const assets: StaticAsset[] = [];
      for (const info of infos) {
        if (!info.success) continue;
        // AssetInfo(uint8 offset, address asset, address priceFeed, uint64 scale, ...)
        assets.push({ asset: addressAt(info.returnData, 1), feed: addressAt(info.returnData, 2), scale: wordAt(info.returnData, 3), symbol: "?" });
      }
      const syms = await this.rpc.multicall([base, ...assets.map((a) => a.asset)].map((t) => ({ target: t, data: SEL.symbol })));
      assets.forEach((a, i) => (a.symbol = syms[i + 1]?.success ? decodeString(syms[i + 1]!.returnData) : "?"));
      kept.push({
        def: m,
        base,
        baseSymbol: syms[0]?.success ? decodeString(syms[0].returnData) : "?",
        baseFeed: addressAt(r[1]!.returnData, 0),
        baseScale: wordAt(r[2]!.returnData, 0),
        assets,
      });
      this.log({ event: "market.ok", chain: this.def.name, market: m.id, comet: m.comet, base: kept.at(-1)!.baseSymbol, assets: assets.map((a) => a.symbol) });
    }
    if (kept.length === 0) throw new Error("no Comet market answered on this RPC");
    this.markets = kept;
    this.ready = true;
    this.error = undefined;
  }

  /** Follow Withdraw / SupplyCollateral logs up to `head`, backfilling on the first run. */
  async scan(head: number): Promise<number> {
    let from = this.lastBlock > 0 ? this.lastBlock + 1 : Math.max(0, head - this.def.backfillBlocks);
    let added = 0;
    while (from <= head) {
      const to = Math.min(head, from + this.chunk - 1);
      try {
        for (const m of this.markets) {
          const logs = await this.rpc.logs(m.def.comet, [[TOPIC.withdraw, TOPIC.supplyCollateral]], from, to);
          const set = this.borrowers.get(m.def.id) ?? new Set<string>();
          for (const l of logs) {
            const t0 = l.topics[0]?.toLowerCase();
            const who = t0 === TOPIC.withdraw ? l.topics[1] : t0 === TOPIC.supplyCollateral ? l.topics[2] : undefined;
            if (!who) continue;
            const a = "0x" + who.slice(-40).toLowerCase();
            if (!set.has(a)) {
              set.add(a);
              added++;
            }
          }
          this.borrowers.set(m.def.id, set);
        }
      } catch (e) {
        if (this.chunk > 500) {
          this.chunk = Math.max(500, Math.floor(this.chunk / 2));
          continue; // retry the same range smaller
        }
        throw e;
      }
      this.lastBlock = to;
      from = to + 1;
    }
    return added;
  }

  /** One sweep: prices, discounts, isLiquidatable for everyone, estimates for absorbable accounts. */
  async check(head: number): Promise<CheckResult> {
    const views: MarketView[] = [];
    for (const m of this.markets) {
      const quoteBase = BigInt(m.def.quoteBaseUnits) * m.baseScale;
      const calls: Call3[] = [
        { target: m.def.comet, data: call(SEL.getPrice, m.baseFeed) },
        { target: m.def.comet, data: SEL.getReserves },
        { target: m.def.comet, data: SEL.targetReserves },
      ];
      for (const a of m.assets) {
        calls.push({ target: m.def.comet, data: call(SEL.getPrice, a.feed) });
        calls.push({ target: m.def.comet, data: call(SEL.quoteCollateral, a.asset, quoteBase) });
        calls.push({ target: m.def.comet, data: call(SEL.getCollateralReserves, a.asset) });
      }
      const r = await this.rpc.multicall(calls);
      const w = (i: number): bigint => (r[i] && okWord(r[i]!) ? wordAt(r[i]!.returnData, 0) : 0n);
      const reservesNow = r[1] && okWord(r[1]) ? intAt(r[1].returnData, 0) : 0n;
      views.push({
        id: m.def.id,
        chain: this.def.name,
        comet: m.def.comet,
        baseSymbol: m.baseSymbol,
        baseScale: m.baseScale,
        basePrice: w(0),
        quoteBase,
        feedUsd: 1,
        forSale: reservesNow < w(2),
        assets: m.assets.map((a, i) => ({ asset: a.asset, symbol: a.symbol, scale: a.scale, price: w(3 + i * 3), quote: w(4 + i * 3), reserves: w(5 + i * 3) })),
      });
    }
    const ethUsd = resolveFeedUsd(this.markets, views, this.ethUsdFallback);

    const gasPrice = await this.rpc.gasPrice();
    const finds: AccountFind[] = [];
    const reserves: CheckResult["reserves"] = [];
    let borrowers = 0;
    for (let mi = 0; mi < this.markets.length; mi++) {
      const m = this.markets[mi]!;
      const v = views[mi]!;
      const accts = [...(this.borrowers.get(m.def.id) ?? [])];
      borrowers += accts.length;
      if (accts.length > 0) {
        const liq = await this.rpc.multicall(accts.map((a) => ({ target: m.def.comet, data: call(SEL.isLiquidatable, a) })));
        const hits = accts.filter((_, i) => liq[i]?.success && liq[i]!.returnData.length >= 66 && wordAt(liq[i]!.returnData, 0) === 1n);
        if (hits.length > 0) {
          const bal = await this.rpc.multicall(hits.flatMap((a) => m.assets.map((x) => ({ target: m.def.comet, data: call(SEL.collateralBalanceOf, a, x.asset) }))));
          hits.forEach((a, hi) => {
            const holdings = m.assets
              .map((x, xi) => {
                const rr = bal[hi * m.assets.length + xi];
                return { asset: x.asset, amount: rr && okWord(rr) ? wordAt(rr.returnData, 0) : 0n };
              })
              .filter((h) => h.amount > 0n);
            finds.push(estimateAccount(v, a, holdings, this.def.gas, gasPrice, ethUsd, this.def.l1FeeUsd, this.swapCostBps));
          });
        }
      }
      for (const e of estimateReserves(v, this.def.gas, gasPrice, ethUsd, this.def.l1FeeUsd, this.swapCostBps)) {
        reserves.push({ chain: this.def.name, market: m.def.id, e });
      }
    }
    this.lastChecked = head;
    return { summary: { chain: this.def.name, markets: this.markets.length, borrowers, lastBlock: head }, finds, reserves };
  }

  state(): ChainState {
    const borrowers: Record<string, string[]> = {};
    for (const [k, v] of this.borrowers) borrowers[k] = [...v];
    return { lastBlock: this.lastBlock, borrowers };
  }
}

/**
 * Fill each view's feedUsd and return ETH/USD.
 * USD markets: 1. "auto" markets: USD price of the base token (from a USD market on the same
 * chain that lists it as collateral) divided by the market's own base price.
 */
export function resolveFeedUsd(markets: { def: MarketDef; base: string }[], views: MarketView[], ethUsdFallback: number): number {
  const usdPrice = new Map<string, number>();
  let ethUsd = 0;
  views.forEach((v, i) => {
    if (markets[i]!.def.denom !== "usd") return;
    for (const a of v.assets) {
      const p = Number(a.price) / 1e8;
      if (p > 0 && !usdPrice.has(a.asset.toLowerCase())) usdPrice.set(a.asset.toLowerCase(), p);
      if (!ethUsd && a.symbol.toUpperCase() === "WETH" && p > 0) ethUsd = p;
    }
  });
  if (!ethUsd) ethUsd = ethUsdFallback;
  views.forEach((v, i) => {
    const m = markets[i]!;
    if (m.def.denom === "usd") {
      v.feedUsd = 1;
      return;
    }
    const baseUsd = usdPrice.get(m.base.toLowerCase()) ?? (v.baseSymbol.toUpperCase() === "WETH" ? ethUsd : 0);
    const own = Number(v.basePrice) / 1e8;
    v.feedUsd = baseUsd > 0 && own > 0 ? baseUsd / own : 0;
  });
  return ethUsd;
}

function writeJsonAtomic(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

export function loadState(path: string): MonitorState {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as MonitorState;
    if (s && s.version === 1 && typeof s.chains === "object") return s;
  } catch {
    /* first run */
  }
  return { version: 1, chains: {} };
}

export interface Args {
  mode: string;
  once: boolean;
  metrics: string;
  state: string;
  finds: string;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    mode: get("--mode") ?? env.FLEET_MODE ?? "detect",
    once: argv.includes("--once"),
    metrics: resolve(get("--metrics") ?? env.FLEET_METRICS_FILE ?? "data/fleet/compound-liquidator.fleet-metrics.json"),
    state: resolve(get("--state") ?? "data/fleet/compound-liquidator.state.json"),
    finds: resolve(get("--finds") ?? "data/fleet/compound-liquidator.finds.jsonl"),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function main(argv = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<number> {
  const args = parseArgs(argv, env);
  if (args.mode !== "detect") {
    console.error(`${VERSION}: only --mode detect exists. This monitor never sends transactions.`);
    return 2;
  }
  const log = (o: object): void => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
  const swapCostBps = Number(env.COMPOUND_SWAP_COST_BPS ?? 30);
  const ethUsdFallback = Number(env.ETH_USD ?? 0) || 0;
  const pollMs = Math.max(250, Number(env.COMPOUND_POLL_MS ?? 1500));
  const saved = loadState(args.state);

  const chains = selectChains(env, CHAINS);
  const watchers: ChainWatcher[] = [];
  const missing: ChainSummary[] = [];
  for (const c of chains) {
    const url = env[c.rpcEnv];
    if (!url) {
      missing.push({ chain: c.name, markets: 0, borrowers: 0, lastBlock: 0, error: `no ${c.rpcEnv} in bots/wrapper/.env` });
      continue;
    }
    watchers.push(new ChainWatcher(c, new Rpc(url), saved.chains[c.name], { swapCostBps, ethUsdFallback, log }));
  }
  log({ event: "start", version: VERSION, mode: "detect", chains: watchers.map((w) => `${w.def.name}@${w.rpc.host}`), missing: missing.map((m) => m.error) });

  const latest = new Map<string, CheckResult>();
  writeJsonAtomic(args.metrics, buildMetrics(missing, [], [], 0));
  const seen = new Set<string>();
  let lastSave = 0;
  let stopping = false;
  const save = (): void => {
    for (const w of watchers) if (w.ready) saved.chains[w.def.name] = w.state();
    writeJsonAtomic(args.state, saved);
  };
  const onSignal = (): void => {
    stopping = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const lastInitTry = new Map<string, number>();
  while (!stopping) {
    const t0 = Date.now();
    let changed = false;
    for (const w of watchers) {
      try {
        if (!w.ready) {
          if (Date.now() - (lastInitTry.get(w.def.name) ?? 0) < 30_000 && !args.once && lastInitTry.has(w.def.name)) continue;
          lastInitTry.set(w.def.name, Date.now());
          await w.init();
        }
        const head = await w.rpc.blockNumber();
        if (w.lastChecked && head - w.lastChecked < w.def.checkEveryBlocks) continue;
        const added = await w.scan(head);
        if (added) log({ event: "borrowers.added", chain: w.def.name, added, head });
        const res = await w.check(head);
        latest.set(w.def.name, res);
        changed = true;
        for (const f of res.finds) {
          const key = `${f.market}:${f.account}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const line = { t: new Date().toISOString(), event: "absorbable", block: head, ...f };
          log(line);
          mkdirSync(dirname(args.finds), { recursive: true });
          appendFileSync(args.finds, JSON.stringify(line) + "\n");
        }
        // forget accounts that are no longer absorbable so a relapse is logged again
        const now = new Set(res.finds.map((f) => `${f.market}:${f.account}`));
        const mine = new Set(w.def.markets.map((m) => m.id));
        for (const k of [...seen]) if (mine.has(k.split(":")[0]!) && !now.has(k)) seen.delete(k);
      } catch (e) {
        w.error = (e as Error).message.slice(0, 160);
        if (!w.ready) w.markets = [];
        latest.set(w.def.name, { summary: { chain: w.def.name, markets: w.markets.length, borrowers: 0, lastBlock: w.lastBlock, error: w.error }, finds: [], reserves: [] });
        changed = true;
        log({ event: "error", chain: w.def.name, error: w.error });
      }
    }
    if (changed || args.once) {
      const all = [...latest.values()];
      const m = buildMetrics(
        [...all.map((r) => r.summary), ...missing],
        all.flatMap((r) => r.finds),
        all.flatMap((r) => r.reserves),
        Date.now() - t0,
      );
      writeJsonAtomic(args.metrics, m);
    }
    if (args.once || Date.now() - lastSave > 60_000) {
      save();
      lastSave = Date.now();
    }
    if (args.once) break;
    await sleep(pollMs);
  }
  save();
  log({ event: "stop" });
  return 0;
}

const norm = (u: string): string => (process.platform === "win32" ? decodeURIComponent(u).toLowerCase() : u);
if (process.argv[1] && norm(import.meta.url) === norm(pathToFileURL(resolve(process.argv[1])).href)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

