/**
 * Local dashboard: http://localhost:8787 (UI_PORT) while the bot runs, or on
 * its own with `node dist/main.js ui` to browse saved results.
 *
 * It shows the bot live (block tape, opportunities, outcomes, competitors,
 * liquidations, RPC budget) and lets you connect a wallet to deploy the
 * RouteExecutor, authorise the bot's key, withdraw profits and top up gas.
 *
 * Security model:
 *   - listens on 127.0.0.1 only: nothing else on your network can reach it
 *   - refuses requests whose Host header isn't localhost / 127.0.0.1, which
 *     blocks DNS-rebinding tricks from websites open in the same browser
 *   - every /api call needs a random token that only the page served by this
 *     process knows (a new one every start)
 *   - never reads or returns PRIVATE_KEY, .env, or RPC URLs with keys in them,
 *     and cannot change settings or switch modes
 *   - wallet transactions are built in the page and signed in YOUR wallet;
 *     the server only supplies public data (balances, contract bytecode)
 *
 * This module has no ethers import on purpose: the few calls it encodes are
 * written out by hand, so it can be tested without a node_modules folder.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_ID, MULTICALL3, TOKENS } from "../config.js";
import type { Settings } from "../config.js";
import { ARB_EXECUTOR_COMPILER, ARB_EXECUTOR_CREATION, ROUTE_EXECUTOR_COMPILER, ROUTE_EXECUTOR_CREATION, LIQ_EXECUTOR_CREATION, LIQ_EXECUTOR_COMPILER } from "../deployBytecode.js";
import { bigintReplacer, log } from "../log.js";
import type { Store } from "../store.js";
import type { Call, CallResult, RpcUsage } from "../rpc.js";
import type { DaySummary } from "../paper.js";
import type { MarketSummary } from "../classifier.js";
import type { LiqDaySummary } from "../liquidations.js";

/** Data files written by the bot (paper.ts, classifier.ts, liquidations.ts, executor.ts). */
const FILES = { opps: "opportunities.jsonl", mev: "mev.jsonl", liq: "liquidations.jsonl", live: "live.jsonl" } as const;

const SEL = {
  getEthBalance: "0x4d2301cc",
  balanceOf: "0x70a08231",
  owner: "0x8da5cb5b",
  operator: "0x570ca735",
};
const WETH_ADDR = TOKENS.WETH!.address;
const USDC_ADDR = TOKENS.USDC!.address;
const isAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const word = (addr: string): string => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const uint = (r: CallResult | undefined): string | null => (r && r.success && r.returnData.length >= 66 ? BigInt(r.returnData.slice(0, 66)).toString() : null);
const addr = (r: CallResult | undefined): string | null => (r && r.success && r.returnData.length >= 66 ? "0x" + r.returnData.slice(26, 66) : null);

export interface BlockEvent {
  n: number;
  at: number;
  ms: number;
  /** Opportunities we found (after gas) and the best net profit among them. */
  opps: number;
  bestNetUsd: number | null;
  /** MEV transactions other bots landed in this block. */
  mev: number;
  arbs: number;
  gasUsd: number;
  ethUsd: number;
}

export interface Summaries {
  paperDays: DaySummary[];
  market?: MarketSummary | undefined;
  liq?: LiqDaySummary | undefined;
}

export interface UiSources {
  version: string;
  settings: Settings;
  store: Store;
  /** False for `node dist/main.js ui`: dashboard only, the bot loop isn't running in this process. */
  running: boolean;
  botAddress?: string | undefined;
  telegram: boolean;
  usage?: () => RpcUsage;
  pools: () => { total: number; cl: number; pairs: number };
  ethUsd: () => number;
  /** The learning engine's summary (null when it's off), the tuning view, and the dashboard's apply/dismiss/reset. */
  learning?: () => unknown;
  tuning?: () => unknown;
  tune?: (action: string, id?: string) => { ok: boolean; error?: string };
  extras?: () => {
    flashblocks?: Record<string, number> | undefined;
    liquidations?: { watched: number; stats: Record<string, number> } | undefined;
    refresh?: { checks: number; driftedPools: number; lastCheckBlock?: number; lastDrift?: Array<{ pool: string; dex: string; block: number }> } | undefined;
    /** Scanner funnel since start (src/scanner.ts `funnel`). */
    funnel?: Record<string, number> | undefined;
    flashblockFunnel?: Record<string, number> | undefined;
    paper?: { recorded: number; alreadyTracked: number } | undefined;
    live?: { consecutiveFailures: number; limit: number; gasSpentTodayUsd: number; maxDailyGasUsd: number } | undefined;
  };
  summaries: () => Promise<Summaries>;
  /** Multicall3 aggregate3 (allowFailure) at the latest block. */
  multicall?: (calls: Call[]) => Promise<CallResult[]>;
  symbol?: (address: string) => string;
  token?: (address: string) => { symbol: string; decimals: number } | undefined;
  /** A pool the bot watches (undefined when it doesn't). */
  pool?: (address: string) => { dex: string; feePpm: number; feeModel: string; cl: boolean } | undefined;
  /** The online copy (src/cloud.ts), when CLOUD_URL is set. */
  cloud?: () => { url: string; lastOkAt: number; pushes: number; failures: number; lastError: string | null } | undefined;
}

interface Client {
  res: ServerResponse;
}

const MAX_CLIENTS = 8;
const TAPE = 90;

export class UiServer {
  readonly token = randomBytes(24).toString("base64url");
  private server: Server | undefined;
  private clients = new Set<Client>();
  private blocks: BlockEvent[] = [];
  private startedAt = Date.now();
  private summaryCache: { at: number; value: Promise<unknown> } | undefined;
  private summaryDirty = false;
  private walletCache = new Map<string, { at: number; value: Promise<unknown> }>();
  private lastFreshWallet = 0;
  private pingTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private allowedHosts = new Set<string>();
  private listeners: Array<(type: string, data: unknown) => void> = [];
  private code = gitInfo(fileURLToPath(new URL("../../", import.meta.url)));
  url = "";

  constructor(
    readonly src: UiSources,
    readonly opts: { port: number; host?: string; htmlPath?: string } = { port: 8787 },
  ) {}

  /**
   * Follow the bot's records (opportunities, outcomes, MEV, liquidations) without
   * serving HTTP. start() does this too; the online mirror (src/cloud.ts) needs
   * it even when the local dashboard is turned off.
   */
  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.src.store.onAppend((file, rec) => this.onRecord(file, rec));
  }

  /** Every live event (block, opp, outcome, mev, liq, liq-outcome, live, stop), for the online mirror. */
  onEvent(fn: (type: string, data: unknown) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn);
    };
  }

  /** Write the STOP file (live sending halts) and tell every viewer. */
  writeStop(reason: string): { present: boolean; reason: string | null } {
    writeFileSync(this.src.store.path("STOP"), `${new Date().toISOString()} ${reason}\n`);
    log.warn(`STOP file written (${reason}); live sending halts. Delete ${this.src.store.path("STOP")} yourself to resume.`);
    const st = this.stopState();
    this.publish("stop", st);
    return st;
  }

  /** Starts listening. Resolves false (and the bot carries on) if the port is taken. */
  async start(): Promise<boolean> {
    this.attach();
    const host = this.opts.host ?? "127.0.0.1";
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: Error) => {
        log.warn("dashboard request failed:", err.message.slice(0, 160));
        if (!res.headersSent) this.json(res, 500, { error: "internal error" });
        else res.end();
      });
    });
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") log.warn(`dashboard: port ${this.opts.port} is already in use (is the bot already running?); set UI_PORT to use another port`);
        else log.warn("dashboard could not start:", err.message);
        resolve(false);
      });
      server.listen(this.opts.port, host, () => resolve(true));
    });
    if (!ok) return false;
    this.server = server;
    const port = (server.address() as { port: number }).port;
    for (const h of ["localhost", "127.0.0.1", "[::1]"]) {
      this.allowedHosts.add(`${h}:${port}`);
      if (port === 80) this.allowedHosts.add(h);
    }
    this.url = `http://localhost:${port}`;
    this.pingTimer = setInterval(() => this.broadcastRaw(": ping\n\n"), 15_000);
    this.pingTimer.unref();
    return true;
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  // -------------------------------------------------------------------------
  // Live feed
  // -------------------------------------------------------------------------

  /** Called by the bot loop after each block. */
  pushBlock(b: BlockEvent): void {
    this.blocks.push(b);
    if (this.blocks.length > TAPE) this.blocks.splice(0, this.blocks.length - TAPE);
    this.publish("block", b);
  }

  publish(type: string, data: unknown): void {
    for (const fn of this.listeners) {
      try {
        fn(type, data);
      } catch {
        /* a listener can never break the bot */
      }
    }
    if (this.clients.size === 0) return;
    this.broadcastRaw(`event: ${type}\ndata: ${JSON.stringify(data, bigintReplacer)}\n\n`);
  }

  private broadcastRaw(chunk: string): void {
    for (const c of this.clients) {
      // A tab that stopped reading (asleep, frozen) must not make the bot buffer
      // without limit: drop it; the page reconnects and reloads its data.
      if (c.res.writableLength > 512 * 1024) {
        c.res.destroy();
        this.clients.delete(c);
        continue;
      }
      try {
        c.res.write(chunk);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  private onRecord(file: string, rec: unknown): void {
    const r = rec as Record<string, unknown>;
    if (file === FILES.opps || file === FILES.liq) this.summaryDirty = true;
    if (file === FILES.opps && r.kind === "opportunity") this.publish("opp", this.slimOpp(r));
    else if (file === FILES.opps && r.kind === "outcome") this.publish("outcome", slimOutcome(r));
    else if (file === FILES.mev) this.publish("mev", this.slimMev(r));
    else if (file === FILES.liq && r.kind === "liq-opportunity") this.publish("liq", slimLiq(r));
    else if (file === FILES.liq && r.kind === "liq-outcome") this.publish("liq-outcome", { id: r.id, status: r.status, takenBy: r.takenBy ?? null });
    else if (file === FILES.live) this.publish("live", { id: r.id, txHash: r.txHash, status: r.status, expectedProfitUsd: r.expectedProfitUsd });
  }

  private slimOpp(r: Record<string, unknown>): Record<string, unknown> {
    const route = r.route as { dexes?: string[]; pools?: string[]; tokens?: string[]; amounts?: unknown[]; executorHops?: Array<{ feePpm?: number }> } | undefined;
    const hops = Number(r.hops ?? route?.pools?.length ?? 2);
    return {
      id: r.id,
      block: r.block,
      foundAt: r.foundAt,
      pair: r.pairSymbols,
      via: route?.dexes ?? [r.buyDex, r.sellDex],
      kind: !route ? "classic" : hops >= 3 ? "triangular" : "cl",
      hops,
      netUsd: r.netUsd,
      profitUsd: r.profitUsd,
      gasUsd: r.gasUsd,
      sim: r.sim,
      simDetail: typeof r.simDetail === "string" ? r.simDetail.slice(0, 200) : null,
      stage: r.stage ?? "block",
      msIntoBlock: r.msIntoBlock ?? null,
      legs: this.legs(r, route),
    };
  }

  /** Hop-by-hop amounts for the opportunity detail view (integer strings + decimals; the page formats them). */
  private legs(
    r: Record<string, unknown>,
    route: { dexes?: string[]; pools?: string[]; tokens?: string[]; amounts?: unknown[]; executorHops?: Array<{ feePpm?: number }> } | undefined,
  ): Array<Record<string, unknown>> {
    const tok = (a: unknown) => {
      const address = String(a ?? "");
      const t = this.src.token?.(address);
      return { address, symbol: t?.symbol ?? this.src.symbol?.(address) ?? address.slice(0, 8), decimals: t?.decimals ?? 18 };
    };
    const fee = (pool: string, given?: number): number | null => {
      const f = given ?? this.src.pool?.(pool)?.feePpm;
      return typeof f === "number" && f >= 0 ? f : null;
    };
    const s = (v: unknown) => (v === undefined || v === null ? null : String(v));
    if (route?.pools && route.tokens && route.amounts) {
      return route.pools.map((pool, i) => ({
        dex: route.dexes?.[i] ?? "?",
        pool,
        from: tok(route.tokens![i]),
        to: tok(route.tokens![i + 1]),
        amountIn: s(route.amounts![i]),
        amountOut: s(route.amounts![i + 1]),
        feePpm: fee(pool, route.executorHops?.[i]?.feePpm),
      }));
    }
    return [
      { dex: r.buyDex, pool: r.buyPool, from: tok(r.tokenIn), to: tok(r.tokenMid), amountIn: s(r.amountIn), amountOut: s(r.amountMid), feePpm: fee(String(r.buyPool)) },
      { dex: r.sellDex, pool: r.sellPool, from: tok(r.tokenMid), to: tok(r.tokenIn), amountIn: s(r.amountMid), amountOut: s(r.amountOut), feePpm: fee(String(r.sellPool)) },
    ];
  }

  private slimMev(r: Record<string, unknown>): Record<string, unknown> {
    const tokens = Array.isArray(r.tokens) ? (r.tokens as string[]) : [];
    return {
      type: r.type,
      block: r.block,
      at: r.timestamp,
      bot: r.bot,
      tx: r.txHash,
      dexes: r.dexes,
      pair: this.src.symbol ? tokens.map((t) => this.src.symbol!(t)).join("/") : "",
      profitUsd: r.profitUsd ?? null,
      costUsd: r.costUsd ?? null,
      priorityGwei: r.priorityGwei ?? null,
      ...this.coverage(r),
    };
  }

  /** How many of a rival trade's pools the bot watches right now. */
  private coverage(r: Record<string, unknown>): { poolsWatched: number | null; poolsTotal: number } {
    const pools = Array.isArray(r.pools) ? (r.pools as string[]) : [];
    if (!this.src.pool) return { poolsWatched: null, poolsTotal: pools.length };
    return { poolsWatched: pools.filter((p) => this.src.pool!(p)).length, poolsTotal: pools.length };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (!this.allowedHosts.has(String(req.headers.host ?? "").toLowerCase())) {
      res.writeHead(421, { "Content-Type": "text/plain" }).end("Open the dashboard at " + this.url);
      return;
    }
    const url = new URL(req.url ?? "/", this.url);
    const method = req.method ?? "GET";

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return this.page(res);
    if (method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    // Every API call carries the page's token: a header for fetch, ?t= for the event stream.
    const given = (req.headers["x-bot-token"] as string | undefined) ?? url.searchParams.get("t");
    if (!this.tokenOk(given)) return this.json(res, 401, { error: "reload the dashboard page" });
    if (method === "POST") {
      const origin = req.headers.origin;
      if (origin && !this.allowedHosts.has(origin.replace(/^https?:\/\//, "").toLowerCase())) return this.json(res, 403, { error: "bad origin" });
    }

    switch (`${method} ${url.pathname}`) {
      case "GET /api/state":
        return this.json(res, 200, this.state());
      case "GET /api/summary":
        return this.json(res, 200, await this.summary());
      case "GET /api/recent":
        return this.json(res, 200, this.recent());
      case "GET /api/events":
        return this.events(req, res);
      case "GET /api/contracts":
        return this.json(res, 200, this.contracts());
      case "GET /api/wallet":
        return this.json(res, 200, await this.wallet(url.searchParams.get("addresses") ?? "", url.searchParams.get("route") ?? undefined, url.searchParams.get("arb") ?? undefined, url.searchParams.get("fresh") === "1", url.searchParams.get("liq") ?? undefined));
      case "GET /api/review":
        return this.json(res, 200, this.review());
      case "POST /api/stop":
        return this.json(res, 200, this.writeStop("stopped from the dashboard"));
      case "POST /api/tuning": {
        // Only this PC's dashboard can change settings: the online copy has no route for it.
        if (!this.src.tune) return this.json(res, 404, { error: "only while the bot runs" });
        let body: { action?: unknown; id?: unknown } = {};
        try {
          body = JSON.parse((await readBody(req, 4096)) || "{}");
        } catch {
          return this.json(res, 400, { error: "bad request" });
        }
        const action = String(body.action ?? "");
        if (!["apply", "dismiss", "unblock", "reset"].includes(action)) return this.json(res, 400, { error: "unknown action" });
        const r = this.src.tune(action, typeof body.id === "string" ? body.id.slice(0, 200) : undefined);
        this.publish("live-status", { tuning: true });
        return this.json(res, 200, { ...r, tuning: this.src.tuning?.() ?? null });
      }
      default:
        return this.json(res, 404, { error: "not found" });
    }
  }

  private tokenOk(given: string | null | undefined): boolean {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body, bigintReplacer));
  }

  private page(res: ServerResponse): void {
    const file = this.opts.htmlPath ?? fileURLToPath(new URL("../../ui/dashboard.html", import.meta.url));
    if (!existsSync(file)) {
      res.writeHead(500, { "Content-Type": "text/plain" }).end(`dashboard page not found at ${file}`);
      return;
    }
    const nonce = randomBytes(16).toString("base64");
    const boot = { token: this.token, version: this.src.version };
    const html = readFileSync(file, "utf8").replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
    const doc =
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
      `<script nonce="${nonce}">window.__BOT__=${JSON.stringify(boot)};</script></head><body>${html}</body></html>`;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Only this page's own scripts run. Other directives stay open so wallet
      // extensions can inject their providers and popups.
      "Content-Security-Policy": `script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(doc);
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    if (this.clients.size >= MAX_CLIENTS) {
      // Oldest tab loses its stream rather than the new one.
      const oldest = this.clients.values().next().value as Client | undefined;
      oldest?.res.end();
      if (oldest) this.clients.delete(oldest);
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify(this.state(), bigintReplacer)}\n\n`);
    const client: Client = { res };
    this.clients.add(client);
    req.on("close", () => this.clients.delete(client));
  }

  // -------------------------------------------------------------------------
  // Payloads
  // -------------------------------------------------------------------------

  private stopState(): { present: boolean; reason: string | null } {
    const file = this.src.store.path("STOP");
    if (!existsSync(file)) return { present: false, reason: null };
    let reason = "";
    try {
      reason = readFileSync(file, "utf8").trim().slice(0, 400);
    } catch {
      /* unreadable */
    }
    return { present: true, reason };
  }

  state(): Record<string, unknown> {
    const s = this.src.settings;
    const x = this.src.extras?.() ?? {};
    return {
      version: this.src.version,
      running: this.src.running,
      mode: s.mode,
      startedAt: new Date(this.startedAt).toISOString(),
      now: new Date().toISOString(),
      chainId: CHAIN_ID,
      ethUsd: this.src.ethUsd(),
      pools: this.src.pools(),
      blocks: this.blocks,
      rpc: this.src.usage?.() ?? null,
      refresh: x.refresh ?? null,
      flashblocks: x.flashblocks ?? null,
      liquidations: x.liquidations ?? null,
      stop: this.stopState(),
      funnel: x.funnel ?? null,
      flashblockFunnel: x.flashblockFunnel ?? null,
      paper: x.paper ?? null,
      safety: {
        mode: s.mode,
        signer: s.mode === "live" && !!s.privateKey,
        liveSubmission: s.mode === "live" && !this.stopState().present,
        maxConsecutiveFailures: Number(process.env.MAX_CONSECUTIVE_FAILURES ?? 5),
        live: x.live ?? null,
      },
      capabilities: capabilities(s),
      learning: this.src.learning?.() ?? null,
      tuning: this.src.tuning?.() ?? null,
      code: this.code,
      cloud: this.src.cloud?.() ?? null,
      telegram: this.src.telegram,
      addresses: {
        bot: this.src.botAddress ?? null,
        executor: s.executorAddress ?? null,
        routeExecutor: s.routeExecutorAddress ?? null,
        liqExecutor: s.liqExecutorAddress ?? null,
      },
      settings: {
        minProfitUsd: s.minProfitUsd,
        maxPools: s.maxPools,
        minPoolLiquidityWeth: s.minPoolLiquidityWeth,
        clPools: s.clPools,
        multiHop: s.multiHop,
        maxHops: s.maxHops,
        flashSource: s.flashSource,
        flashblocks: s.flashblocks,
        liquidations: s.liquidations,
        refreshMode: s.refreshMode,
        fullRefreshBlocks: s.fullRefreshBlocks,
        priorityFeeGwei: s.priorityFeeGwei,
        rpcFallbacks: s.rpcFallbackUrls.length,
        mevFeed: s.mevFeed,
        /** Whether PRIVATE_KEY is set (the bot has its own wallet); never the key itself. */
        hasBotKey: !!s.privateKey,
        maxDailyGasUsd: Number(process.env.MAX_DAILY_GAS_USD ?? 20),
      },
    };
  }

  /**
   * Summaries re-read the data files, so they're cached: recomputed when new
   * records arrived (at most every 10s) and otherwise every 60s.
   */
  async summary(): Promise<unknown> {
    const now = Date.now();
    const age = this.summaryCache ? now - this.summaryCache.at : Infinity;
    if (age > 60_000 || (this.summaryDirty && age > 10_000)) {
      this.summaryDirty = false;
      const value = this.src.summaries().then((x) => slimSummaries(x));
      this.summaryCache = { at: now, value };
      value.catch(() => (this.summaryCache = undefined));
    }
    return this.summaryCache!.value;
  }

  recent(): Record<string, unknown> {
    const store = this.src.store;
    const oppRecs = store.tail<Record<string, unknown>>(FILES.opps, 768 * 1024);
    const outcomes = new Map<string, Record<string, unknown>>();
    for (const r of oppRecs) if (r.kind === "outcome") outcomes.set(String(r.id), r);
    const opps = oppRecs
      .filter((r) => r.kind === "opportunity")
      .slice(-40)
      .reverse()
      .map((r) => ({ ...this.slimOpp(r), outcome: outcomes.has(String(r.id)) ? slimOutcome(outcomes.get(String(r.id))!) : null }));
    const mevRecs = store.tail<Record<string, unknown>>(FILES.mev, 768 * 1024).filter((r) => r.kind === "mev");
    const mev = mevRecs
      .slice(-40)
      .reverse()
      .map((r) => this.slimMev(r));
    // Coverage of recent rival arbitrages: did they trade only pools we watch?
    const arbs = mevRecs.filter((r) => r.type === "arbitrage").slice(-300);
    const coverage = { sample: arbs.length, allWatched: 0, someWatched: 0, noneWatched: 0 };
    if (this.src.pool) {
      for (const r of arbs) {
        const c = this.coverage(r);
        if (c.poolsTotal && c.poolsWatched === c.poolsTotal) coverage.allWatched++;
        else if (c.poolsWatched) coverage.someWatched++;
        else coverage.noneWatched++;
      }
    }
    const liqRecs = store.tail<Record<string, unknown>>(FILES.liq, 192 * 1024);
    const liqOut = new Map<string, Record<string, unknown>>();
    for (const r of liqRecs) if (r.kind === "liq-outcome") liqOut.set(String(r.id), r);
    const liq = liqRecs
      .filter((r) => r.kind === "liq-opportunity")
      .slice(-20)
      .reverse()
      .map((r) => ({ ...slimLiq(r), outcome: liqOut.get(String(r.id))?.status ?? null, takenBy: liqOut.get(String(r.id))?.takenBy ?? null }));
    const liveById = new Map<string, Record<string, unknown>>();
    for (const r of store.tail<Record<string, unknown>>(FILES.live, 64 * 1024)) liveById.set(String(r.id), r);
    const live = [...liveById.values()].slice(-20).reverse();
    return { opps, mev, coverage, liq, live };
  }

  contracts(): Record<string, unknown> {
    const s = this.src.settings;
    return {
      chainId: CHAIN_ID,
      bot: this.src.botAddress ?? null,
      routeExecutor: {
        address: s.routeExecutorAddress ?? null,
        creationBytecode: ROUTE_EXECUTOR_CREATION,
        bytes: (ROUTE_EXECUTOR_CREATION.length - 2) / 2,
        compiler: ROUTE_EXECUTOR_COMPILER,
      },
      arbExecutor: {
        address: s.executorAddress ?? null,
        creationBytecode: ARB_EXECUTOR_CREATION,
        bytes: (ARB_EXECUTOR_CREATION.length - 2) / 2,
        compiler: ARB_EXECUTOR_COMPILER,
      },
      liqExecutor: {
        address: s.liqExecutorAddress ?? null,
        creationBytecode: LIQ_EXECUTOR_CREATION,
        bytes: (LIQ_EXECUTOR_CREATION.length - 2) / 2,
        compiler: LIQ_EXECUTOR_COMPILER,
      },
      tokens: {
        WETH: { address: WETH_ADDR, decimals: 18 },
        USDC: { address: USDC_ADDR, decimals: 6 },
      },
    };
  }

  /**
   * ETH / WETH / USDC balances of the given addresses (plus the bot), and the
   * executors' owner, operator and balances. One eth_call. `routeOverride` and
   * `arbOverride` are contracts the page just deployed that aren't in .env yet.
   */
  async wallet(list: string, routeOverride?: string, arbOverride?: string, fresh = false, liqOverride?: string): Promise<unknown> {
    if (!this.src.multicall) return { error: "balances are only available while the bot runs (node dist/main.js run) or with node dist/main.js ui" };
    const s = this.src.settings;
    const accounts = [...new Set([...list.split(","), this.src.botAddress ?? ""].map((a) => a.trim().toLowerCase()).filter(isAddress))].slice(0, 6);
    const contracts = [
      // The page only passes a route override while .env holds an outdated RouteExecutor (or none), so it wins here.
      ["routeExecutor", isAddress(routeOverride) ? routeOverride : s.routeExecutorAddress],
      ["arbExecutor", s.executorAddress ?? (isAddress(arbOverride) ? arbOverride : undefined)],
      ["liqExecutor", s.liqExecutorAddress ?? (isAddress(liqOverride) ? liqOverride : undefined)],
    ].filter((c): c is [string, string] => isAddress(c[1]));
    const key = [...accounts, ...contracts.map((c) => c[1])].join(",");
    const hit = this.walletCache.get(key);
    // Cached, so more open tabs never mean more RPC calls. Right after one of your transactions
    // the page asks for a fresh read (at most one every 3 s), so a button you just used updates.
    const allowFresh = fresh && Date.now() - this.lastFreshWallet > 3000;
    if (allowFresh) this.lastFreshWallet = Date.now();
    if (hit && !allowFresh && Date.now() - hit.at < 30_000) return hit.value;
    const value = (async () => {
      const calls: Call[] = [];
      const bal = (a: string) => {
        calls.push({ target: MULTICALL3, callData: SEL.getEthBalance + word(a) });
        calls.push({ target: WETH_ADDR, callData: SEL.balanceOf + word(a) });
        calls.push({ target: USDC_ADDR, callData: SEL.balanceOf + word(a) });
      };
      for (const a of accounts) bal(a);
      for (const [, a] of contracts) {
        bal(a);
        calls.push({ target: a, callData: SEL.owner });
        calls.push({ target: a, callData: SEL.operator });
      }
      const r = await this.src.multicall!(calls);
      let i = 0;
      const out: Record<string, unknown> = { at: new Date().toISOString(), accounts: {}, contracts: {} };
      for (const a of accounts) {
        (out.accounts as Record<string, unknown>)[a] = { eth: uint(r[i]), weth: uint(r[i + 1]), usdc: uint(r[i + 2]) };
        i += 3;
      }
      for (const [name, a] of contracts) {
        const owner = addr(r[i + 3]);
        (out.contracts as Record<string, unknown>)[name] = {
          address: a,
          deployed: owner !== null,
          eth: uint(r[i]),
          weth: uint(r[i + 1]),
          usdc: uint(r[i + 2]),
          owner,
          operator: addr(r[i + 4]),
        };
        i += 5;
      }
      return out;
    })();
    this.walletCache.set(key, { at: Date.now(), value });
    value.catch(() => this.walletCache.delete(key));
    if (this.walletCache.size > 20) this.walletCache.delete(this.walletCache.keys().next().value as string);
    return value;
  }

  /** The newest reports/ai-review-*.md written by the daily Opus review. */
  review(): Record<string, unknown> {
    const dir = this.src.settings.reportDir;
    try {
      const files = readdirSync(dir)
        .filter((f) => /^ai-review-.*\.md$/i.test(f))
        .sort();
      const latest = files.at(-1);
      if (!latest) return { file: null };
      const path = join(dir, latest);
      return { file: latest, modified: statSync(path).mtime.toISOString(), text: readFileSync(path, "utf8").slice(0, 64 * 1024), count: files.length };
    } catch {
      return { file: null };
    }
  }
}

function slimOutcome(r: Record<string, unknown>): Record<string, unknown> {
  return { id: r.id, status: r.status, realisticNetUsd: r.realisticNetUsd, takenBy: r.takenBy ?? null, takenTx: r.takenTx ?? null };
}

function slimLiq(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    block: r.block,
    foundAt: r.foundAt,
    user: r.user,
    healthFactor: r.healthFactor,
    debtSymbol: r.debtSymbol,
    collateralSymbol: r.collateralSymbol,
    repayUsd: r.repayUsd,
    bonusPct: r.bonusPct,
    estProfitUsd: r.estProfitUsd,
  };
}

function slimSummaries(x: Summaries): Record<string, unknown> {
  const day = new Date().toISOString().slice(0, 10);
  const today = x.paperDays.find((d) => d.day === day);
  return {
    generatedAt: new Date().toISOString(),
    day,
    days: x.paperDays.slice(0, 14).map((d) => ({
      day: d.day,
      found: d.found,
      persisted: d.persisted,
      taken: d.taken,
      closed: d.closed,
      pending: d.pending,
      simMismatches: d.simMismatches,
      realisticNetUsd: d.realisticNetUsd,
      optimisticNetUsd: d.optimisticNetUsd,
    })),
    today: today
      ? {
          byKind: today.byKind,
          byStage: today.byStage,
          scores: today.scores.slice(0, 10),
          takers: today.takers,
          byPair: today.byPair.slice(0, 8),
        }
      : null,
    market: x.market
      ? {
          arbitrageTxs: x.market.arbitrageTxs,
          arbitrageProfitUsd: x.market.arbitrageProfitUsd,
          sandwichTxs: x.market.sandwichTxs,
          sandwichProfitUsd: x.market.sandwichProfitUsd,
          bots: x.market.bots.slice(0, 10),
          topPairs: x.market.topPairs.slice(0, 8),
          hourly: x.market.hourly,
          arbPriority: x.market.arbPriority,
        }
      : null,
    liq: x.liq ?? null,
  };
}

/** Branch and commit of the checkout the bot started from (read from .git; no git command needed). */
function gitInfo(root: string): { branch: string | null; commit: string | null } {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return { branch: null, commit: head.slice(0, 7) };
    const ref = head.slice(4).trim();
    const branch = ref.replace(/^refs\/heads\//, "");
    let commit: string | null = null;
    const refFile = join(root, ".git", ...ref.split("/"));
    if (existsSync(refFile)) commit = readFileSync(refFile, "utf8").trim();
    else {
      const packed = readFileSync(join(root, ".git", "packed-refs"), "utf8");
      const line = packed.split(/\r?\n/).find((l) => l.endsWith(` ${ref}`));
      commit = line ? line.split(" ")[0]! : null;
    }
    return { branch, commit: commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 7) : null };
  } catch {
    return { branch: null, commit: null };
  }
}

/**
 * What the code can actually do, and how far each piece has been proven.
 * Kept by hand next to the code it describes: update it when a capability
 * changes, so the dashboard never shows something as more ready than it is.
 */
export function capabilities(s: Settings): Array<{ name: string; built: "yes" | "partly" | "no"; tested: string; paper: "on" | "off" | "n/a"; live: "allowed" | "blocked" | "n/a" }> {
  const on = (b: boolean): "on" | "off" => (b ? "on" : "off");
  return [
    {
      name: "Two-pool trades on V2-style pools (Uniswap V2, SushiSwap, BaseSwap, Aerodrome)",
      built: "yes",
      tested: "Maths unit tests and a full paper run on a mock chain; ArbExecutor EVM tests need solc",
      paper: "on",
      live: "allowed",
    },
    {
      name: "Concentrated-liquidity pools (Uniswap V3, Aerodrome Slipstream)",
      built: "yes",
      tested: "Tick maths checked against reference values; every find re-checked by the DEX's own quoter or a simulation",
      paper: on(s.clPools),
      live: "blocked",
    },
    {
      name: "Triangular and multi-hop routes (RouteExecutor)",
      built: "yes",
      tested: "Route engine unit tests; RouteExecutor EVM tests (forge, 9 passing)",
      paper: on(s.multiHop),
      live: "blocked",
    },
    {
      name: "Reacting to Flashblocks (pre-confirmed state)",
      built: "yes",
      tested: "Not covered by automated tests",
      paper: on(s.flashblocks),
      live: "blocked",
    },
    {
      name: "Aave V3 liquidations",
      built: "partly",
      tested: "Monitor only: profit is an estimate, not simulated; not covered by automated tests",
      paper: on(s.liquidations),
      live: "n/a",
    },
    { name: "Uniswap V4, Curve and Balancer pools", built: "no", tested: "Helper-agent task", paper: "n/a", live: "n/a" },
    { name: "Splitting a trade across several pools", built: "no", tested: "Helper-agent task", paper: "n/a", live: "n/a" },
    { name: "Liquidation executor contract", built: "no", tested: "Helper-agent task", paper: "n/a", live: "n/a" },
    { name: "Encrypted key store (instead of PRIVATE_KEY in .env)", built: "no", tested: "Helper-agent task", paper: "n/a", live: "n/a" },
  ];
}

/** A small request body, or an error past `max` bytes. */
function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
