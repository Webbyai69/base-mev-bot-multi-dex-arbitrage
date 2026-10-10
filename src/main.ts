/**
 * Entry point / CLI.
 *
 *   node dist/main.js check      verify RPC + every configured address
 *   node dist/main.js discover   (re)build the pool watch list -> data/pools.json
 *   node dist/main.js scan       one-shot: print the best routes right now
 *   node dist/main.js run        the bot loop (paper or live per .env)  [default]
 *   node dist/main.js report     regenerate today's HTML report
 *   node dist/main.js summary    print paper-trading and market summaries
 *   node dist/main.js digest     write reports/digest-latest.md (what the daily AI review reads)
 *   node dist/main.js ui         the dashboard on its own (saved results + wallet), without the bot loop
 *   node dist/main.js telegram   set up Telegram alerts: find your chat id, then send a test message
 *
 * While "run" is going, the dashboard is at http://localhost:8787 (UI_PORT).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import { loadSettings, type Settings } from "./config.js";
import { Chain, redactUrl } from "./rpc.js";
import { PoolRegistry, type PoolSnapshot } from "./pools.js";
import { Scanner, type RouteOptions } from "./scanner.js";
import { GasEstimator } from "./gas.js";
import { Store } from "./store.js";
import { PaperEngine, summarize } from "./paper.js";
import { Classifier, fetchFullBlock, marketSummary } from "./classifier.js";
import { renderReport, writeReport } from "./report.js";
import { LiveExecutor, pickLiveSend, summarizeLive } from "./executor.js";
import { Learner, Tuning } from "./learn.js";
import { addBotWalletToEnv } from "./wallet.js";
import { runCheck } from "./check.js";
import { log, setLogLevel } from "./log.js";
import { formatUnits } from "./math.js";
import { LiquidationMonitor, liquidationSummary } from "./liquidations.js";
import { planLiquidation } from "./liquidate.js";
import { FlashblockWatcher } from "./flashblocks.js";
import { renderDigest, writeDigest } from "./digest.js";
import { poolsOf, flashSourceId, routeKey, type Opportunity } from "./scanner.js";
import { BlockLogFetcher } from "./blocklogs.js";
import { UiServer, type Summaries, type UiSources } from "./ui/server.js";
import { Alerts, telegramSetup } from "./alerts.js";
import { CloudPublisher } from "./cloud.js";

const POOLS_FILE = "pools.json";

/** Set in main(); the crash handlers use it to send a last alert. */
let alerts: Alerts | undefined;

function version(): string {
  try {
    return (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }).version;
  } catch {
    return "?";
  }
}

/** The bot's public address: BOT_ADDRESS, or derived from PRIVATE_KEY (the key itself never leaves this process). */
function botAddressOf(s: Settings): string | undefined {
  if (s.botAddress) return s.botAddress;
  if (!s.privateKey) return undefined;
  try {
    return new Wallet(s.privateKey).address;
  } catch {
    return undefined;
  }
}

function poolCounts(registry: PoolRegistry): { total: number; cl: number; pairs: number } {
  return {
    total: registry.pools.size,
    cl: [...registry.pools.values()].filter((p) => p.cl).length,
    pairs: [...registry.groups().values()].filter((g) => g.length >= 2).length,
  };
}

function safeEthUsd(registry: PoolRegistry): number {
  try {
    const p = registry.pools.size ? registry.ethPrice() : 0;
    return Number.isFinite(p) ? p : 0;
  } catch {
    return 0;
  }
}

async function dashboardSummaries(store: Store, registry: PoolRegistry, s: Settings): Promise<Summaries> {
  const day = new Date().toISOString().slice(0, 10);
  const [paperDays, market, liq] = await Promise.all([summarize(store), marketSummary(store, (a) => registry.symbol(a), s.watchBots, [day]), liquidationSummary(store, [day])]);
  return { paperDays, market: market[0], liq: liq[0] };
}

function dashboardSources(s: Settings, chain: Chain, registry: PoolRegistry, store: Store, running: boolean, extras?: Extras): UiSources {
  return {
    cloud: () => extras?.cloud?.status(),
    version: version(),
    settings: s,
    store,
    running,
    botAddress: botAddressOf(s),
    telegram: !!alerts?.enabled,
    // Without the bot loop (the "ui" command) there is no RPC traffic worth showing.
    usage: running ? () => chain.usage() : undefined,
    pools: () => poolCounts(registry),
    ethUsd: () => safeEthUsd(registry),
    extras: () => ({
      flashblocks: extras?.fb?.stats,
      liquidations: extras?.liq ? { watched: extras.liq.watched, stats: extras.liq.stats } : undefined,
      refresh: extras?.refreshStats,
      funnel: extras?.scanner ? { ...extras.scanner.funnel } : undefined,
      flashblockFunnel: extras?.fbScanner ? { ...extras.fbScanner.funnel } : undefined,
      paper: extras?.paper ? { ...extras.paper.stats } : undefined,
      live: extras?.live?.safety,
    }),
    token: (a) => {
      const t = registry.token(a);
      return t ? { symbol: t.symbol, decimals: t.decimals } : undefined;
    },
    pool: (a) => {
      const p = registry.pools.get(a.toLowerCase());
      return p ? { dex: p.dex, feePpm: p.feePpm, feeModel: p.feeModel, cl: !!p.cl } : undefined;
    },
    summaries: () => dashboardSummaries(store, registry, s),
    multicall: (calls) => chain.multicall(calls),
    symbol: (a) => registry.symbol(a),
    learning: () => (extras?.learner ? { ...extras.learner.summary(Date.now(), extras.tuning?.blocked), recentSkips: extras.scanner?.lastLearnedSkips.slice(0, 6) ?? [], topPools: topPoolsView(registry, extras.learner) } : null),
    tuning: () => extras?.tuning?.view() ?? null,
    tune: (action, id) => extras?.tune?.(action, id) ?? { ok: false, error: "only while the bot runs" },
  };
}

/**
 * Top watched pools by value-score, enriched with pair/dex for the dashboard. Liquidity
 * comes from the registry (the learner never reads reserves), so this lives here.
 */
function topPoolsView(registry: PoolRegistry, learner: Learner, n = 12) {
  const ethUsd = registry.pools.size ? registry.ethPrice() : 0;
  const liqOf = (addr: string): number => {
    const p = registry.pools.get(addr);
    return p ? registry.liquidityInWeth(p, ethUsd) : 0;
  };
  return learner.topPools(liqOf, n).map((t) => {
    const p = registry.pools.get(t.pool);
    return { ...t, dex: p?.dex ?? "?", pair: p ? `${registry.symbol(p.token0)}/${registry.symbol(p.token1)}` : "", watched: !!p };
  });
}

/** The newest reports/ai-review-*.md (written by the daily AI review), or null. */
function latestReviewText(reportDir: string): string | null {
  try {
    const files = readdirSync(reportDir).filter((f) => /^ai-review-.*\.md$/i.test(f)).sort();
    const last = files[files.length - 1];
    return last ? readFileSync(join(reportDir, last), "utf8").slice(0, 64 * 1024) : null;
  } catch {
    return null;
  }
}

/** Yesterday's numbers to Telegram when the UTC day rolls over. */
async function sendDailyAlert(store: Store, registry: PoolRegistry, s: Settings, day: string): Promise<void> {
  if (!alerts?.enabled) return;
  const [paper, market, liq] = await Promise.all([summarize(store, [day]), marketSummary(store, (a) => registry.symbol(a), s.watchBots, [day]), liquidationSummary(store, [day])]);
  const p = paper[0];
  await alerts.daily({
    day,
    found: p?.found ?? 0,
    persisted: p?.persisted ?? 0,
    taken: p?.taken ?? 0,
    closed: p?.closed ?? 0,
    realisticNetUsd: p?.realisticNetUsd ?? 0,
    optimisticNetUsd: p?.optimisticNetUsd ?? 0,
    topRival: market[0]?.bots[0]?.bot,
    liqFound: liq[0]?.found,
  });
}

async function loadOrDiscover(registry: PoolRegistry, store: Store, s: Settings, force = false): Promise<void> {
  const snap = force ? undefined : store.readJson<PoolSnapshot>(POOLS_FILE);
  if (snap && snap.version === 1 && snap.pools.length > 0) {
    registry.loadSnapshot(snap);
    log.info(`loaded ${registry.pools.size} pools from ${store.path(POOLS_FILE)} (discovered ${snap.discoveredAt}); run "discover" to rebuild`);
    if (s.clPools && !snap.pools.some((p) => p.cl)) {
      log.warn(`this pool list has no Uniswap V3 / Slipstream pools — run "node dist/main.js discover" once to add them (most Base volume is there)`);
    }
    return;
  }
  await registry.discover({
    minLiquidityWeth: s.minPoolLiquidityWeth,
    maxPools: s.maxPools,
    mode: s.discovery,
    lookbackBlocks: s.discoveryLookbackBlocks,
    logRange: s.discoveryLogRange,
  });
  store.writeJson(POOLS_FILE, registry.toSnapshot(await registry.chain.blockNumber()));
  log.info(`saved ${registry.pools.size} pools to ${store.path(POOLS_FILE)}`);
}

function routeOptions(s: Settings): RouteOptions {
  return {
    multiHop: s.multiHop,
    maxHops: s.maxHops,
    maxCycles: s.maxCycles,
    gasRouteBase: s.gasRouteBase,
    gasHopV2: s.gasHopV2,
    gasHopCl: s.gasHopCl,
    ...(s.routeExecutorAddress ? { routeExecutorAddress: s.routeExecutorAddress } : {}),
    flashSource: s.flashSource,
  };
}

interface RefreshStats {
  checks: number;
  driftedPools: number;
  lastCheckBlock: number;
  /** Pools that differed from a full re-read at the last self-check that found any. */
  lastDrift: Array<{ pool: string; dex: string; block: number }>;
}

interface Extras {
  liq?: LiquidationMonitor;
  fb?: FlashblockWatcher;
  chain?: Chain;
  refreshStats?: RefreshStats;
  scanner?: Scanner;
  fbScanner?: Scanner;
  paper?: PaperEngine;
  live?: LiveExecutor;
  cloud?: CloudPublisher;
  learner?: Learner;
  tuning?: Tuning;
  /** Apply / dismiss / reset a suggested setting change from the dashboard. */
  tune?: (action: string, id?: string) => { ok: boolean; error?: string };
}

async function writeDailyReport(store: Store, registry: PoolRegistry, s: Settings, day = new Date().toISOString().slice(0, 10), extras: Extras = {}): Promise<string> {
  const [paper, market, liq] = await Promise.all([summarize(store, [day]), marketSummary(store, (a) => registry.symbol(a), s.watchBots, [day]), liquidationSummary(store, [day])]);
  const html = renderReport(
    day,
    paper[0],
    market[0],
    {
      mode: s.mode,
      pools: registry.pools.size,
      clPools: [...registry.pools.values()].filter((p) => p.cl).length,
      pairs: [...registry.groups().values()].filter((g) => g.length >= 2).length,
      ethUsd: registry.pools.size ? registry.ethPrice() : 0,
      ...(extras.liq ? { borrowersWatched: extras.liq.watched } : {}),
    },
    liq[0],
  );
  return writeReport(s.reportDir, day, html);
}

async function writeDailyDigest(store: Store, registry: PoolRegistry, s: Settings, day = new Date().toISOString().slice(0, 10), extras: Extras = {}): Promise<string> {
  const [paperDays, market, liq, liveDays] = await Promise.all([
    summarize(store),
    marketSummary(store, (a) => registry.symbol(a), s.watchBots, [day]),
    liquidationSummary(store, [day]),
    summarizeLive(store, registry.ethPrice()),
  ]);
  const text = renderDigest({
    day,
    settings: s,
    pools: {
      total: registry.pools.size,
      cl: [...registry.pools.values()].filter((p) => p.cl).length,
      pairs: [...registry.groups().values()].filter((g) => g.length >= 2).length,
    },
    ...(extras.liq ? { borrowersWatched: extras.liq.watched } : {}),
    paperDays,
    ...(market[0] ? { market: market[0] } : {}),
    ...(liq[0] ? { liq: liq[0] } : {}),
    ...(extras.fb ? { flashblockStats: extras.fb.stats } : {}),
    ...(extras.chain ? { rpc: extras.chain.usage() } : {}),
    ...(extras.refreshStats ? { refreshStats: extras.refreshStats } : {}),
    ...(extras.scanner ? { funnel: { ...extras.scanner.funnel }, recorded: extras.paper ? { ...extras.paper.stats } : undefined } : {}),
    ...(extras.learner ? { learning: extras.learner.summary(Date.now(), extras.tuning?.blocked) } : {}),
    ...(extras.tuning ? { tuning: extras.tuning.view() } : {}),
    ...(liveDays.length || extras.live
      ? {
          live: {
            days: liveDays,
            ...(extras.live
              ? {
                  safety: {
                    blocked: extras.live.safety.blocked,
                    stopFile: store.exists("STOP"),
                    gasSpentTodayUsd: extras.live.safety.gasSpentTodayUsd,
                    maxDailyGasUsd: extras.live.safety.maxDailyGasUsd,
                    consecutiveFailures: extras.live.safety.consecutiveFailures,
                    limit: extras.live.safety.limit,
                  },
                }
              : {}),
          },
        }
      : {}),
  });
  return writeDigest(s.reportDir, day, text);
}

async function run(s: Settings, chain: Chain, registry: PoolRegistry, store: Store): Promise<void> {
  await loadOrDiscover(registry, store, s);
  const routeOpts = routeOptions(s);
  const scanner = new Scanner(chain, registry, s.executorAddress, s.simOverride, routeOpts);
  log.info(`on-chain verification: ${scanner.simMode}${scanner.simMode === "override" ? " (ArbExecutor bytecode injected via eth_call state override; no deployment needed)" : ""}`);
  if (s.multiHop) log.info(`multi-hop and CL routes: up to ${s.maxHops} hops, verified by ${scanner.routeSimMode === "quoter" ? "each DEX's quoter" : `RouteExecutor.simulate() (${scanner.routeSimMode})`}; ${s.mode === "live" && s.routeExecutorAddress ? "sent live through your RouteExecutor" : "paper only (set ROUTE_EXECUTOR_ADDRESS to trade them live)"}`);
  const gas = new GasEstimator(chain, s.arbGasLimit, s.priorityFeeGwei);
  const paper = new PaperEngine(store, registry);
  const classifier = s.mevFeed ? new Classifier(chain, registry, store) : undefined;
  const extras: Extras = {};
  if (s.liquidations) {
    const liq = new LiquidationMonitor(chain, store, {
      lookbackBlocks: s.liqLookbackBlocks,
      checkEvery: s.liqCheckEvery,
      swapCostBps: s.liqSwapCostBps,
      gasUnits: 450_000,
      minDebtUsd: 50,
      outcomeBlocks: 5,
    });
    try {
      await liq.init(await chain.blockNumber());
      extras.liq = liq;
    } catch (err) {
      log.warn("liquidation monitor disabled (could not read Aave V3):", (err as Error).message.slice(0, 140));
    }
  }
  if (s.flashblocks) {
    const fbChain = new Chain(s.flashblocksRpcUrl);
    const fbScanner = new Scanner(fbChain, registry, s.executorAddress, s.simOverride, routeOpts);
    extras.fbScanner = fbScanner;
    extras.fb = new FlashblockWatcher(fbChain, registry, fbScanner, paper, {
      pollMs: s.flashblockPollMs,
      maxPools: s.flashblockMaxPools,
      minProfitUsd: s.minProfitUsd,
    });
  }
  // The learning engine: remembers what keeps failing, where rivals win and what they pay,
  // across restarts (data/learned.json), and the setting changes you approve (data/tuning.json).
  const tuning = new Tuning(store, { minProfitUsd: s.minProfitUsd, maxBidShare: s.liveMaxBidShare, evMinUsd: s.liveMinEvUsd });
  extras.tuning = tuning;
  const learner = s.learning
    ? new Learner(store, { halfLifeMs: s.learnHalfLifeHours * 3_600_000, pruneAfterMs: s.learnPruneDays * 86_400_000, maxBidGwei: s.liveMaxBidGwei }, (a) => registry.symbol(a))
    : undefined;
  if (learner) {
    // Trades by the bot's own wallet or contract are its own results, never a rival's.
    learner.setSelf([s.executorAddress, botAddressOf(s)]);
    const how = await learner.load();
    learner.track(registry.pools.keys());
    const L = learner.summary();
    log.info(
      how === "loaded"
        ? `learning: picked up where it left off (${L.counts.sims} test runs, ${L.counts.outcomes} outcomes, ${L.counts.rivalArbs} rival trades since ${L.since.slice(0, 10)})`
        : how === "warm-start" || how === "relearned"
          ? `learning: ${how === "relearned" ? "re-learned from past data with this version's rules" : "learned from past data first"} (${L.counts.sims} test runs, ${L.counts.outcomes} outcomes, ${L.counts.rivalArbs} rival trades since ${L.since.slice(0, 10)}); ${L.skipping.length} tokens to skip`
          : "learning: starting fresh",
    );
    scanner.learner = learner;
    scanner.blockedTokens = () => tuning.blocked;
    if (extras.fbScanner) {
      extras.fbScanner.learner = learner;
      extras.fbScanner.blockedTokens = () => tuning.blocked;
    }
    paper.onOutcome = (o, status, takenBy) => learner.onOutcome(o, status, takenBy);
    extras.learner = learner;
    // Lift any dashboard block that this version's corrected blame rule no longer supports. A 0.6.0
    // suggestion blamed a hub token (e.g. VIRTUAL) for the small tokens paired with it; re-learned
    // with the fix, those are no longer unreliable, so unblock them and let their pools come back.
    const stillBad = new Set(learner.badTokens(Date.now(), 6, 0.8).map((t) => t.token));
    for (const t of [...tuning.blocked]) {
      if (stillBad.has(t) || s.tokenBlacklist.has(t)) continue; // genuinely bad, or pinned in .env
      const r = tuning.act("unblock", t);
      if (r.ok) log.info(`learning: unblocked ${registry.symbol(t)} (${t}) — with the corrected blame rule it no longer looks unreliable; its pools return as other bots trade them`);
    }
    tuning.refresh(learner, latestReviewText(s.reportDir));
  }
  // Tokens you blocked on the dashboard stay out of discovery and the watch list.
  const dropToken = (token: string): number => {
    registry.blacklist.add(token);
    const drop = [...registry.pools.values()].filter((p) => p.token0.toLowerCase() === token || p.token1.toLowerCase() === token);
    for (const p of drop) registry.pools.delete(p.address.toLowerCase());
    if (drop.length) registry.dirty = true;
    return drop.length;
  };
  for (const t of tuning.blocked) dropToken(t);
  const tv = tuning.view();
  if (Object.keys(tv.overrides).length || tv.blockedTokens.length) {
    log.info(
      `tuning from the dashboard: ${Object.entries(tv.overrides)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}${tv.blockedTokens.length ? `${Object.keys(tv.overrides).length ? ", " : ""}${tv.blockedTokens.length} blocked tokens` : ""} (data/tuning.json)`,
    );
  }
  extras.tune = (action, id) => {
    const r = tuning.act(action, id);
    if (r.ok) {
      const dropped = r.blockedToken ? dropToken(r.blockedToken) : 0;
      let back = "";
      if (r.unblockedToken) {
        // Its pools come back as other bots trade them (the watch list), or with "discover".
        if (s.tokenBlacklist.has(r.unblockedToken)) back = "; it stays out because TOKEN_BLACKLIST in .env lists it";
        else {
          registry.blacklist.delete(r.unblockedToken);
          back = "; its pools come back as other bots trade them";
        }
      }
      log.info(`tuning: ${action}${id ? ` ${id}` : ""} from the dashboard${dropped ? `; stopped watching ${dropped} pools` : ""}${back}`);
      if (learner) tuning.refresh(learner, latestReviewText(s.reportDir));
    }
    return r;
  };

  const live =
    s.mode === "live"
      ? new LiveExecutor(chain, store, s.privateKey!, s.executorAddress!, {
          gasLimit: s.arbGasLimit,
          priorityFeeGwei: s.priorityFeeGwei,
          maxDailyGasUsd: Number(process.env.MAX_DAILY_GAS_USD ?? 20),
          maxConsecutiveFailures: Number(process.env.MAX_CONSECUTIVE_FAILURES ?? 5),
          useFlash: (process.env.USE_FLASH ?? "true") !== "false",
          // With a deployed RouteExecutor, concentrated-liquidity and multi-hop routes go live too.
          ...(s.routeExecutorAddress ? { routeExecutorAddress: s.routeExecutorAddress, routeGasLimit: s.routeGasLimit, routeFlashSource: flashSourceId(s.flashSource) } : {}),
          // With a deployed LiquidationExecutor and LIQUIDATIONS_LIVE=true, Aave liquidations are sent live.
          ...(s.liquidationsLive && s.liqExecutorAddress ? { liqExecutorAddress: s.liqExecutorAddress, liqGasLimit: s.liqGasLimit } : {}),
        })
      : undefined;
  if (live) log.warn(`LIVE MODE: sending from ${live.wallet.address} via executor ${s.executorAddress}${s.routeExecutorAddress ? ` and routes via ${s.routeExecutorAddress}` : ""}. Create ${store.path("STOP")} to halt.`);
  if (live && s.liveActAlways) log.warn("LIVE: act mode ON — sending every simulated-profitable find (bid sized by the learning), bounded by the daily gas cap and circuit breaker. Set LIVE_ACT_ALWAYS=false for expected-value gating.");

  let lastReport = 0;
  let blocksSeen = 0;
  const t0 = Date.now();

  let lastDigest = 0;
  let lastLearnSave = Date.now();
  // The first prune waits an hour after start, so a restart never drops pools straight away.
  let lastPrune = Date.now();
  const quietSkips = new Map<string, number>();
  let lastFullRefresh = 0;
  const refreshStats: RefreshStats = { checks: 0, driftedPools: 0, lastCheckBlock: 0, lastDrift: [] };
  extras.refreshStats = refreshStats;
  extras.scanner = scanner;
  extras.paper = paper;
  if (live) extras.live = live;
  extras.chain = chain;

  // Dashboard, online copy and alerts. None of them can stop the bot: a busy
  // port, an unreachable Worker or Telegram only log a warning.
  const cloudOn = !!(s.cloudUrl && s.cloudToken);
  const ui = s.ui || cloudOn ? new UiServer(dashboardSources(s, chain, registry, store, true, extras), { port: s.uiPort }) : undefined;
  if (ui && s.ui && (await ui.start())) log.info(`dashboard: ${ui.url} (open it in a browser on this computer)`);
  if (ui && cloudOn) {
    ui.attach();
    extras.cloud = new CloudPublisher(ui, {
      url: s.cloudUrl!,
      token: s.cloudToken!,
      accessClientId: s.cloudAccessClientId,
      accessClientSecret: s.cloudAccessClientSecret,
      intervalMs: s.cloudPushMs,
    });
    extras.cloud.start();
    log.info(`online dashboard: pushing to ${s.cloudUrl} every ${Math.round(s.cloudPushMs / 1000)} s${s.cloudAccessClientId ? " (with an Access service token)" : ""}`);
  }
  alerts?.watch(store);
  if (live) {
    live.onTrip = (reason) => {
      void alerts?.circuitBreaker(reason);
      ui?.publish("stop", { present: true, reason });
    };
    live.onReadyChange = (ready, reason) => {
      void alerts?.liveReady(ready, { bot: live.wallet.address, maxDailyGasUsd: live.opts.maxDailyGasUsd, reason });
      ui?.publish("live-status", { ready, reason });
    };
    if (learner) live.onResult = (o, status, gasUsd, bid) => learner.onLive(o, status, gasUsd, bid);
    // Nothing is sent until the contract, the bot wallet's role and its gas money check out.
    live.startChecks();
  }

  // Decide whether to send a live trade from a set of finds, and do it. Used by both the
  // confirmed-block handler and the faster Flashblocks loop (routes only when the RouteExecutor is live).
  const considerLiveSend = (opps: Opportunity[], ethUsd: number, stage: "block" | "flashblock"): void => {
    if (!live || !learner) return;
    const ctx = { ethUsd, gasUnits: s.arbGasLimit, basePriorityGwei: s.priorityFeeGwei, maxBidShare: tuning.maxBidShare, evMinUsd: tuning.evMinUsd, act: s.liveActAlways };
    const { send, passed } = pickLiveSend(opps, learner, ctx, live.routeReady);
    for (const x of passed) {
      const key = routeKey(x.o);
      if (Date.now() - (quietSkips.get(key) ?? 0) < 300_000) continue;
      quietSkips.set(key, Date.now());
      log.info(`live: not sending ${x.o.pairSymbols} (net $${x.o.netUsd.toFixed(3)}): expected value $${x.ev.evUsd.toFixed(3)}, lands ${(x.ev.pLand * 100).toFixed(0)}% of the time on ${x.ev.evidence.toFixed(1)} outcomes`);
    }
    if (!send) return;
    const sent = send.o.route ? live.trySendRoute(send.o, ethUsd, send.ev.bidGwei) : live.trySend(send.o, ethUsd, send.ev.bidGwei);
    if (sent) log.info(`live${stage === "flashblock" ? " [flashblock]" : ""}: sending ${send.o.pairSymbols}${send.o.route ? ` (${send.o.route.pools.length}-hop route)` : ""} (net $${send.o.netUsd.toFixed(3)}): lands ${(send.ev.pLand * 100).toFixed(0)}% of the time on ${send.ev.evidence.toFixed(1)} outcomes, expected $${send.ev.evUsd.toFixed(3)}, bid ${send.ev.bidGwei} gwei (${send.ev.bidWhy})`);
  };
  if (live) extras.fb?.setLiveSend(considerLiveSend);
  // Rank the Flashblocks hot set by pool value-score (depth × rival/find frequency × spread), so the
  // most valuable pools are re-read first at the pre-confirmed state. Node-independent; paper or live.
  if (extras.fb && learner)
    extras.fb.setScorer((pool) => {
      const p = registry.pools.get(pool);
      return p ? learner.poolScore(pool, registry.liquidityInWeth(p, registry.ethPrice())).score : 0;
    });

  // Live Aave liquidations (opt-in: LIQUIDATIONS_LIVE + a deployed LiquidationExecutor). Latency-tolerant,
  // so it suits a home PC; each one is simulated on-chain first and sent through the owner-controlled contract.
  if (live && s.liquidationsLive && s.liqExecutorAddress && extras.liq) {
    const liqSource = flashSourceId(s.flashSource);
    const liqAddr = s.liqExecutorAddress;
    extras.liq.onLiquidatable = (pos) => {
      if (!live.liqReady) return;
      void (async () => {
        try {
          const ethUsd = registry.ethPrice();
          const plan = await planLiquidation(chain, registry, pos, { ethUsd, minProfitUsd: tuning.minProfitUsd, liqExecutorAddress: liqAddr, source: liqSource }, "latest");
          if (plan && live.trySendLiquidation(plan, ethUsd)) {
            log.warn(`live: sending liquidation of ${pos.user.slice(0, 10)} (${pos.debtSymbol}->${pos.collateralSymbol}), simulated profit $${plan.expectedProfitUsd.toFixed(2)}`);
          }
        } catch (err) {
          log.warn("live liquidation failed:", (err as Error).message.slice(0, 140));
        }
      })();
    };
    log.warn(`LIVE: Aave liquidations will be sent through ${liqAddr} when positions become liquidatable`);
  }
  const counts = poolCounts(registry);
  void alerts?.started({ version: version(), pools: counts.total, clPools: counts.cl, dashboard: s.cloudUrl || ui?.url || undefined });
  // Start the stall clock now, so a feed that never delivers a first block also alerts.
  let lastBlockAt = Date.now();
  let lastBlockN = 0;
  let lastFailovers = 0;
  let currentDay = new Date().toISOString().slice(0, 10);
  const watchdog = setInterval(() => {
    alerts?.watchdog(lastBlockN, lastBlockAt);
    const u = chain.usage();
    if (u.failovers > lastFailovers) {
      lastFailovers = u.failovers;
      void alerts?.failover(u.activeEndpoint);
    }
  }, 30_000);
  watchdog.unref();
  const logsFetcher = new BlockLogFetcher(chain, { liquidations: !!extras.liq });
  log.info(
    s.refreshMode === "events"
      ? `pool refresh: event-driven (one eth_getLogs per block, re-reading only pools that changed; full re-read every ${s.fullRefreshBlocks} blocks)`
      : "pool refresh: full re-read of every pool every block (REFRESH_MODE=full)",
  );
  const onBlock = async (n: number): Promise<void> => {
    try {
      await handleBlock(n);
    } finally {
      // Whatever happened in this block, never leave the Flashblocks loop paused.
      if (extras.fb) extras.fb.paused = false;
    }
  };
  const handleBlock = async (n: number): Promise<void> => {
    const started = Date.now();
    // The Flashblocks loop shares pool objects with us: pause it and let any in-flight read finish.
    if (extras.fb) {
      extras.fb.paused = true;
      await extras.fb.idle;
    }
    // One block fetch serves the gas estimator (base fee) and the classifier (tx senders);
    // one log fetch serves the pool refresh, the classifier and the liquidation monitor.
    const canEvents = s.refreshMode === "events" && registry.syncedBlock > 0 && n - registry.syncedBlock <= s.maxLogGap;
    const periodic = n - lastFullRefresh >= s.fullRefreshBlocks;
    const [blk, logs] = await Promise.all([fetchFullBlock(chain, n), logsFetcher.fetch(canEvents ? registry.syncedBlock + 1 : n, n)]);
    if (canEvents) await registry.applyLogs(logs, n);
    learner?.onPoolActivity(logs.map((l) => l.address));
    if (!canEvents || periodic) {
      // Periodic full re-read; in events mode it doubles as a self-check of the log-driven state.
      const snap = canEvents ? registry.stateSnapshot() : null;
      await registry.refreshAll(n);
      lastFullRefresh = n;
      if (snap) {
        const drift = registry.driftAgainst(snap);
        refreshStats.checks++;
        refreshStats.driftedPools += drift.length;
        refreshStats.lastCheckBlock = n;
        if (drift.length) refreshStats.lastDrift = drift.slice(0, 12).map((a) => ({ pool: a, dex: registry.pools.get(a)?.dex ?? "?", block: n }));
        if (drift.length) {
          log.warn(
            `event refresh drift: ${drift.length} of ${snap.size} pools differed from a full re-read at block ${n} (${drift
              .slice(0, 4)
              .map((a) => `${registry.pools.get(a)?.dex ?? "?"} ${a.slice(0, 10)}`)
              .join(", ")}${drift.length > 4 ? ", …" : ""}); corrected`,
          );
        }
      }
    }
    // V4 pools are read from StateView (there is no pool contract), isolated from the address-based refresh
    // above and wrapped so a V4 error can never break the block loop.
    await registry.refreshV4(n).catch((e: Error) => log.warn("V4 refresh:", e.message.slice(0, 120)));
    const baseFee = blk?.baseFeePerGas ? BigInt(blk.baseFeePerGas) : null;
    const ethUsd = registry.ethPrice();
    // Run the MEV classifier (which fetches transaction receipts) concurrently with the trade path, so its RPC
    // latency hides under the scan + send instead of adding to the block time that trips the "Lagging" badge.
    const detectedP = classifier
      ? classifier.classifyBlock(n, ethUsd, blk, logs).catch((e: Error) => (log.warn("classifier failed:", e.message.slice(0, 120)), []))
      : Promise.resolve([]);
    const gasQuote = await gas.quote(n, baseFee);
    // Incremental scan: re-score only the pools this block's events actually touched, plus every pool
    // sharing their token pair (the other side of a spread), instead of all ~1,900 pools every block.
    // The full scan was taking over Base's 2s block budget (the "Lagging" badge) and starving the
    // Flashblocks loop, which is paused while this runs. A full scan still runs on the periodic refresh
    // block and whenever we can't derive a touched set (non-events mode), as a safety net. Persistence is
    // measured by the paper engine re-pricing tracked opps directly, so a narrower find set never distorts
    // the still-there/taken/closed outcomes.
    let scanOnly: Set<string> | undefined;
    if (canEvents && !periodic) {
      const touched = new Set<string>();
      for (const l of logs) if (registry.pools.has(l.address)) touched.add(l.address);
      for (const p of registry.pools.values()) if (p.v4) touched.add(p.address); // V4 is read from StateView, not in logs
      scanOnly = registry.siblings(touched);
    }
    const opps = await scanner.scan(n, gasQuote, ethUsd, tuning.minProfitUsd, { stage: "block", only: scanOnly });
    // Send first: it needs only the refreshed pools and the gas quote, not the classifier's output.
    if (live && learner) {
      considerLiveSend(opps, ethUsd, "block");
    } else if (live) {
      const pick = opps.filter((o) => !o.route && o.sim === "executor-ok").sort((a, b) => b.netUsd - a.netUsd)[0];
      if (pick) live.trySend(pick, ethUsd);
    }
    // Then the measurement, with the classifier result (already in flight) now awaited.
    const detected = await detectedP;
    learner?.onRivalArbs(detected);
    paper.onBlock(n, opps, detected, ethUsd);
    if (extras.fb) {
      // Hot pools for the next ~2s: anything that showed a spread or was arbed by another bot.
      const interesting = new Set<string>([...scanner.lastCandidatePools, ...detected.filter((d) => d.type === "arbitrage").flatMap((d) => d.pools)]);
      for (const o of opps) for (const p of poolsOf(o)) interesting.add(p);
      extras.fb.onConfirmedBlock({ block: n, seenAt: Date.now(), gas: gasQuote, ethUsd }, [...interesting].filter((a) => registry.pools.has(a)));
      extras.fb.paused = false;
      extras.fb.start();
    }
    if (extras.liq) {
      const gasPrice = gasQuote.baseFeeWei + gasQuote.priorityFeeWei;
      extras.liq.onBlock(n, ethUsd, gasPrice, logs).catch((e: Error) => log.warn("liquidation monitor:", e.message.slice(0, 120)));
    }

    // Learn pools that real bots trade on, a few per block so discovery stays cheap.
    if (classifier && registry.pools.size < s.maxWatchedPools) {
      const cands = classifier.candidatePoolsToWatch(detected).slice(0, Math.min(5, s.maxWatchedPools - registry.pools.size));
      if (cands.length) {
        const added = await registry.addPoolsByAddress(cands.map((c) => c.address)).catch((e: Error) => (log.warn("watch-list add failed:", e.message.slice(0, 100)), []));
        for (const p of added) log.info(`watch list: added ${p.dex} pool ${p.address} (${registry.symbol(p.token0)}/${registry.symbol(p.token1)}) seen in an arbitrage`);
        learner?.track(added.map((p) => p.address));
      }
    }
    if (registry.dirty) {
      registry.dirty = false;
      store.writeJson(POOLS_FILE, registry.toSnapshot(n));
    }

    blocksSeen++;
    const ms = Date.now() - started;
    lastBlockAt = Date.now();
    lastBlockN = n;
    alerts?.blockProcessed(n);
    ui?.pushBlock({
      n,
      at: lastBlockAt,
      ms,
      opps: opps.length,
      bestNetUsd: opps.length ? Math.max(...opps.map((o) => o.netUsd)) : null,
      mev: detected.length,
      arbs: detected.filter((d) => d.type === "arbitrage").length,
      gasUsd: (Number(gasQuote.totalWei) / 1e18) * ethUsd,
      ethUsd,
    });
    const today = new Date().toISOString().slice(0, 10);
    if (today !== currentDay) {
      const finished = currentDay;
      currentDay = today;
      sendDailyAlert(store, registry, s, finished).catch((e: Error) => log.warn("daily alert failed:", e.message.slice(0, 120)));
    }
    if (blocksSeen % 30 === 0 || ms > 1800) {
      const fb = extras.fb ? `, flashblocks ${extras.fb.stats.scans} scans/${extras.fb.stats.opps} opps` : "";
      const lq = extras.liq ? `, ${extras.liq.watched} borrowers` : "";
      const u = chain.usage();
      const rpcNote = `, rpc ${u.requests} calls (~${(u.alchemyCuPerDay / 1e6).toFixed(1)}M Alchemy CU/day at this pace)`;
      log.info(`block ${n}: ${registry.pools.size} pools, ${opps.length} opps, ${detected.length} mev txs, ${ms}ms, gas/tx $${((Number(gasQuote.totalWei) / 1e18) * ethUsd).toFixed(4)}${fb}${lq}${rpcNote}, uptime ${((Date.now() - t0) / 60000).toFixed(0)}m`);
    }
    if (learner && Date.now() - lastLearnSave > 60_000) {
      lastLearnSave = Date.now();
      learner.save();
    }
    if (learner && Date.now() - lastPrune > 3_600_000) {
      lastPrune = Date.now();
      const prune = learner.pruneList([...registry.pools.values()]);
      if (prune.length) {
        for (const a of prune) registry.pools.delete(a);
        registry.dirty = true;
        learner.notePruned(prune);
        log.info(`learning: stopped watching ${prune.length} pools (no swaps, finds or rival trades for ${s.learnPruneDays} days, or every test run through them failed); ${registry.pools.size} left`);
      }
    }
    if (Date.now() - lastReport > 60_000) {
      lastReport = Date.now();
      writeDailyReport(store, registry, s, undefined, extras).catch((e: Error) => log.warn("report failed:", e.message));
    }
    if (Date.now() - lastDigest > 10 * 60_000) {
      lastDigest = Date.now();
      if (learner) tuning.refresh(learner, latestReviewText(s.reportDir));
      writeDailyDigest(store, registry, s, undefined, extras).catch((e: Error) => log.warn("digest failed:", e.message));
    }
  };

  const stop = await chain.subscribeBlocks(onBlock);
  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down…");
    stop();
    clearInterval(watchdog);
    extras.fb?.stop();
    extras.liq?.saveBorrowers(await chain.blockNumber().catch(() => 0));
    learner?.save(true);
    await writeDailyReport(store, registry, s, undefined, extras).catch(() => undefined);
    await writeDailyDigest(store, registry, s, undefined, extras).catch(() => undefined);
    void alerts?.stopped(why);
    await extras.cloud?.stop().catch(() => undefined);
    await alerts?.flush();
    await ui?.close().catch(() => undefined);
    await chain.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("stopped from the console (Ctrl+C)"));
  process.on("SIGTERM", () => void shutdown("the process was asked to stop (SIGTERM)"));
}

async function scanOnce(s: Settings, chain: Chain, registry: PoolRegistry, store: Store): Promise<void> {
  await loadOrDiscover(registry, store, s);
  const n = await chain.blockNumber();
  const blk = await chain.getBlock(n);
  await registry.refreshAll(n);
  const ethUsd = registry.ethPrice();
  const gasQuote = await new GasEstimator(chain, s.arbGasLimit, s.priorityFeeGwei).quote(n, blk?.baseFeePerGas ?? null);
  const scanner = new Scanner(chain, registry, s.executorAddress, s.simOverride, routeOptions(s));
  const raw = scanner.findRaw();
  const routes = scanner.findRoutes();
  const opps = await scanner.scan(n, gasQuote, ethUsd, -Infinity);
  console.log(`block ${n} · ETH $${ethUsd.toFixed(2)} · est. gas per arb $${((Number(gasQuote.totalWei) / 1e18) * ethUsd).toFixed(4)} · ${raw.length} classic + ${routes.length} multi-hop/CL positive-spread routes before gas`);
  if (opps.length === 0) {
    console.log("no priced routes right now (spreads are inside the fees or the token cannot be priced)");
    return;
  }
  for (const o of opps.slice(0, 15)) {
    const dec = registry.token(o.tokenIn)?.decimals ?? 18;
    console.log(
      `${o.netUsd >= 0 ? "+" : ""}${o.netUsd.toFixed(4)} USD net  ${o.pairSymbols.padEnd(16)} ${o.route ? `via ${o.route.dexes.join(">").padEnd(24)}` : `buy ${o.buyDex.padEnd(12)} sell ${o.sellDex.padEnd(12)}`} in ${formatUnits(o.amountIn, dec, 5)} ${o.tokenInSymbol}  profit $${o.profitUsd.toFixed(4)}  sim=${o.sim}${o.simDetail ? ` (${o.simDetail})` : ""}`,
    );
  }
}

async function printSummary(s: Settings, store: Store, registry: PoolRegistry): Promise<void> {
  const paper = await summarize(store);
  const market = await marketSummary(store, (a) => registry.symbol(a), s.watchBots);
  console.log("\n=== Paper trading ===");
  if (paper.length === 0) console.log("no opportunities recorded yet");
  for (const d of paper) {
    console.log(`${d.day}: found ${d.found} | optimistic $${d.optimisticNetUsd.toFixed(2)} | realistic $${d.realisticNetUsd.toFixed(2)} | landed ${d.persisted} taken ${d.taken} closed ${d.closed} pending ${d.pending} | sim mismatches ${d.simMismatches}`);
    for (const r of d.byRoute) console.log(`   ${r.route}: ${r.count} ($${r.netUsd.toFixed(2)})`);
    for (const k of d.byKind) console.log(`   [${k.key}] found ${k.found}, landed ${k.persisted}, taken ${k.taken}, win rate ${k.winRate === null ? "–" : (k.winRate * 100).toFixed(0) + "%"}, realistic $${k.realisticNetUsd.toFixed(2)}`);
    for (const k of d.byStage) console.log(`   [found on ${k.key}] ${k.found}, landed ${k.persisted}, realistic $${k.realisticNetUsd.toFixed(2)}`);
  }
  const liq = await liquidationSummary(store);
  console.log("\n=== Aave V3 liquidations (paper) ===");
  if (liq.length === 0) console.log("no liquidatable positions recorded yet");
  for (const d of liq) console.log(`${d.day}: found ${d.found} | ours (open) ${d.open} | taken ${d.taken} | recovered ${d.recovered} | realistic $${d.realisticProfitUsd.toFixed(2)} (est. $${d.estProfitUsd.toFixed(2)})`);
  console.log("\n=== Base MEV market ===");
  if (market.length === 0) console.log("no MEV transactions recorded yet");
  for (const d of market) {
    console.log(`${d.day}: arbitrage ${d.arbitrageTxs} ($${d.arbitrageProfitUsd.toFixed(2)}) | sandwich ${d.sandwichTxs} ($${d.sandwichProfitUsd.toFixed(2)})`);
    for (const b of d.bots.slice(0, 10)) console.log(`   ${b.bot} txs ${b.txs} profit $${b.profitUsd.toFixed(2)}${b.unpricedTxs ? "*" : ""}`);
    for (const p of d.topPairs.slice(0, 8)) console.log(`   pair ${p.pair}: ${p.txs} txs $${p.profitUsd.toFixed(2)}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "run";
  if (cmd === "new-wallet") {
    // Before loadSettings: live-mode validation must not stop you creating the wallet live mode needs.
    const r = addBotWalletToEnv(".env");
    if (!r.created) {
      console.log(`${r.reason}${r.address ? ` (bot wallet ${r.address})` : ""}. Nothing changed.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Bot wallet created: ${r.address}`);
    console.log("Its private key is saved in .env as PRIVATE_KEY (not shown). Anyone who gets that file can spend this");
    console.log("wallet's ETH, so keep .env private. The wallet only ever needs to hold gas money.");
    if (r.botAddressUpdated) console.log("BOT_ADDRESS in .env pointed at a different wallet; it now matches the new one.");
    console.log("Next: restart the bot, open http://localhost:8787, connect your own wallet, and use Live setup.");
    return;
  }
  const s = loadSettings();
  setLogLevel(s.logLevel);
  const store = new Store(s.dataDir);
  const chain = new Chain(
    s.rpcUrl,
    s.wsUrl,
    {
      ...(s.rpcConcurrency !== undefined ? { concurrency: s.rpcConcurrency } : {}),
      ...(s.rpcMinIntervalMs !== undefined ? { minIntervalMs: s.rpcMinIntervalMs } : {}),
      ...(s.rpcBatchMaxCount !== undefined ? { batchMaxCount: s.rpcBatchMaxCount } : {}),
    },
    s.rpcFallbackUrls,
  );
  log.info(
    `rpc ${redactUrl(s.rpcUrl)}${s.rpcFallbackUrls.length ? ` (+${s.rpcFallbackUrls.length} fallback: ${s.rpcFallbackUrls.map(redactUrl).join(", ")})` : ""} · concurrency ${chain.opts.concurrency}, min interval ${chain.opts.minIntervalMs}ms, batch ${chain.opts.batchMaxCount}`,
  );
  const registry = new PoolRegistry(chain);
  registry.clPools = s.clPools;
  // A copy: tokens blocked on the dashboard join it at run time, TOKEN_BLACKLIST from .env stays as written.
  registry.blacklist = new Set(s.tokenBlacklist);
  if (cmd === "run" && s.telegramBotToken && s.telegramChatId) {
    alerts = new Alerts({
      token: s.telegramBotToken,
      chatId: s.telegramChatId,
      mode: s.mode,
      minOppUsd: s.alertMinProfitUsd,
      minLiqUsd: s.alertMinLiqProfitUsd,
      maxPerHour: s.alertMaxPerHour,
      secrets: [s.privateKey ?? "", s.rpcUrl, s.wsUrl ?? "", s.flashblocksRpcUrl, ...s.rpcFallbackUrls].filter((x) => x.length >= 8),
    });
    log.info(`telegram alerts on (opportunities from $${s.alertMinProfitUsd}, liquidations from $${s.alertMinLiqProfitUsd}, at most ${s.alertMaxPerHour}/hour)`);
  } else if (cmd === "run" && (s.telegramBotToken || s.telegramChatId)) {
    log.warn("telegram alerts off: set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (run: node dist/main.js telegram)");
  }
  try {
    switch (cmd) {
      case "check": {
        const ok = await runCheck(chain, { clPools: s.clPools, flashLoans: s.multiHop, liquidations: s.liquidations });
        console.log(ok ? "\nAll checks passed." : "\nSome checks FAILED — fix the addresses in src/config.ts before running.");
        process.exitCode = ok ? 0 : 1;
        break;
      }
      case "discover":
        await loadOrDiscover(registry, store, s, true);
        break;
      case "scan":
        await scanOnce(s, chain, registry, store);
        break;
      case "report": {
        const snap = store.readJson<PoolSnapshot>(POOLS_FILE);
        if (snap) registry.loadSnapshot(snap);
        const day = process.argv[3] ?? new Date().toISOString().slice(0, 10);
        const file = await writeDailyReport(store, registry, s, day);
        console.log(`report written to ${file}`);
        break;
      }
      case "digest": {
        const snap = store.readJson<PoolSnapshot>(POOLS_FILE);
        if (snap) registry.loadSnapshot(snap);
        const file = await writeDailyDigest(store, registry, s, process.argv[3] ?? new Date().toISOString().slice(0, 10));
        console.log(`digest written to ${file}`);
        break;
      }
      case "summary": {
        const snap = store.readJson<PoolSnapshot>(POOLS_FILE);
        if (snap) registry.loadSnapshot(snap);
        await printSummary(s, store, registry);
        break;
      }
      case "run":
        await run(s, chain, registry, store);
        return; // keeps running
      case "ui": {
        const snap = store.readJson<PoolSnapshot>(POOLS_FILE);
        if (snap) registry.loadSnapshot(snap);
        const ui = new UiServer(dashboardSources(s, chain, registry, store, false), { port: s.uiPort });
        if (!(await ui.start())) {
          console.log(`Nothing started: port ${s.uiPort} is in use. If the bot is running, its dashboard is already at http://localhost:${s.uiPort}`);
          process.exitCode = 1;
          await chain.destroy();
          break;
        }
        console.log(`Dashboard: ${ui.url}   (saved results only: the bot loop isn't running in this window; Ctrl+C to stop)`);
        process.on("SIGINT", () => void ui.close().then(() => chain.destroy()).finally(() => process.exit(0)));
        return; // keeps serving
      }
      case "telegram":
        process.exitCode = await telegramSetup(s.telegramBotToken, s.telegramChatId);
        break;
      default:
        console.log("usage: node dist/main.js [check|discover|scan|run|report|summary|digest|ui|telegram|new-wallet]");
    }
  } finally {
    if (cmd !== "run" && cmd !== "ui") await chain.destroy();
  }
}

/** Log, send one last alert (scrubbed of secrets), then exit non-zero — the same outcome as before, plus the alert. */
async function die(err: unknown): Promise<never> {
  log.error((err as Error)?.stack ?? String(err));
  if (alerts) {
    void alerts.crashed(err);
    await alerts.flush();
  }
  process.exit(1);
}
process.on("uncaughtException", (err) => void die(err));
process.on("unhandledRejection", (err) => void die(err));

main().catch((err) => void die(err));
