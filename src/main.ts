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
 */
import { loadSettings, type Settings } from "./config.js";
import { Chain, redactUrl } from "./rpc.js";
import { PoolRegistry, type PoolSnapshot } from "./pools.js";
import { Scanner, type RouteOptions } from "./scanner.js";
import { GasEstimator } from "./gas.js";
import { Store } from "./store.js";
import { PaperEngine, summarize } from "./paper.js";
import { Classifier, fetchFullBlock, marketSummary } from "./classifier.js";
import { renderReport, writeReport } from "./report.js";
import { LiveExecutor } from "./executor.js";
import { runCheck } from "./check.js";
import { log, setLogLevel } from "./log.js";
import { formatUnits } from "./math.js";
import { LiquidationMonitor, liquidationSummary } from "./liquidations.js";
import { FlashblockWatcher } from "./flashblocks.js";
import { renderDigest, writeDigest } from "./digest.js";
import { poolsOf } from "./scanner.js";
import { BlockLogFetcher } from "./blocklogs.js";

const POOLS_FILE = "pools.json";

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

interface Extras {
  liq?: LiquidationMonitor;
  fb?: FlashblockWatcher;
  chain?: Chain;
  refreshStats?: { checks: number; driftedPools: number };
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
  const [paperDays, market, liq] = await Promise.all([summarize(store), marketSummary(store, (a) => registry.symbol(a), s.watchBots, [day]), liquidationSummary(store, [day])]);
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
  });
  return writeDigest(s.reportDir, day, text);
}

async function run(s: Settings, chain: Chain, registry: PoolRegistry, store: Store): Promise<void> {
  await loadOrDiscover(registry, store, s);
  const routeOpts = routeOptions(s);
  const scanner = new Scanner(chain, registry, s.executorAddress, s.simOverride, routeOpts);
  log.info(`on-chain verification: ${scanner.simMode}${scanner.simMode === "override" ? " (ArbExecutor bytecode injected via eth_call state override; no deployment needed)" : ""}`);
  if (s.multiHop) log.info(`multi-hop routes: up to ${s.maxHops} hops, verified by ${scanner.routeSimMode === "quoter" ? "each DEX's quoter" : `RouteExecutor.simulate() (${scanner.routeSimMode})`}; paper only`);
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
    extras.fb = new FlashblockWatcher(fbChain, registry, fbScanner, paper, {
      pollMs: s.flashblockPollMs,
      maxPools: s.flashblockMaxPools,
      minProfitUsd: s.minProfitUsd,
    });
  }
  const live =
    s.mode === "live"
      ? new LiveExecutor(chain, store, s.privateKey!, s.executorAddress!, {
          gasLimit: s.arbGasLimit,
          priorityFeeGwei: s.priorityFeeGwei,
          maxDailyGasUsd: Number(process.env.MAX_DAILY_GAS_USD ?? 20),
          maxConsecutiveFailures: Number(process.env.MAX_CONSECUTIVE_FAILURES ?? 5),
          useFlash: (process.env.USE_FLASH ?? "true") !== "false",
        })
      : undefined;
  if (live) log.warn(`LIVE MODE: sending from ${live.wallet.address} via executor ${s.executorAddress}. Create ${store.path("STOP")} to halt.`);

  let lastReport = 0;
  let blocksSeen = 0;
  const t0 = Date.now();

  let lastDigest = 0;
  let lastFullRefresh = 0;
  const refreshStats = { checks: 0, driftedPools: 0 };
  extras.refreshStats = refreshStats;
  extras.chain = chain;
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
    if (!canEvents || periodic) {
      // Periodic full re-read; in events mode it doubles as a self-check of the log-driven state.
      const snap = canEvents ? registry.stateSnapshot() : null;
      await registry.refreshAll(n);
      lastFullRefresh = n;
      if (snap) {
        const drift = registry.driftAgainst(snap);
        refreshStats.checks++;
        refreshStats.driftedPools += drift.length;
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
    const baseFee = blk?.baseFeePerGas ? BigInt(blk.baseFeePerGas) : null;
    const ethUsd = registry.ethPrice();
    const [gasQuote, detected] = await Promise.all([
      gas.quote(n, baseFee),
      classifier ? classifier.classifyBlock(n, ethUsd, blk, logs).catch((e: Error) => (log.warn("classifier failed:", e.message.slice(0, 120)), [])) : Promise.resolve([]),
    ]);
    const opps = await scanner.scan(n, gasQuote, ethUsd, s.minProfitUsd, { stage: "block" });
    paper.onBlock(n, opps, detected, ethUsd);
    if (live && opps[0]) live.trySend(opps[0], ethUsd);
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
    if (classifier) {
      const cands = classifier.candidatePoolsToWatch(detected).slice(0, 5);
      if (cands.length) {
        const added = await registry.addPoolsByAddress(cands.map((c) => c.address)).catch((e: Error) => (log.warn("watch-list add failed:", e.message.slice(0, 100)), []));
        for (const p of added) log.info(`watch list: added ${p.dex} pool ${p.address} (${registry.symbol(p.token0)}/${registry.symbol(p.token1)}) seen in an arbitrage`);
      }
    }
    if (registry.dirty) {
      registry.dirty = false;
      store.writeJson(POOLS_FILE, registry.toSnapshot(n));
    }

    blocksSeen++;
    const ms = Date.now() - started;
    if (blocksSeen % 30 === 0 || ms > 1800) {
      const fb = extras.fb ? `, flashblocks ${extras.fb.stats.scans} scans/${extras.fb.stats.opps} opps` : "";
      const lq = extras.liq ? `, ${extras.liq.watched} borrowers` : "";
      const u = chain.usage();
      const rpcNote = `, rpc ${u.requests} calls (~${(u.alchemyCuPerDay / 1e6).toFixed(1)}M Alchemy CU/day at this pace)`;
      log.info(`block ${n}: ${registry.pools.size} pools, ${opps.length} opps, ${detected.length} mev txs, ${ms}ms, gas/tx $${((Number(gasQuote.totalWei) / 1e18) * ethUsd).toFixed(4)}${fb}${lq}${rpcNote}, uptime ${((Date.now() - t0) / 60000).toFixed(0)}m`);
    }
    if (Date.now() - lastReport > 60_000) {
      lastReport = Date.now();
      writeDailyReport(store, registry, s, undefined, extras).catch((e: Error) => log.warn("report failed:", e.message));
    }
    if (Date.now() - lastDigest > 10 * 60_000) {
      lastDigest = Date.now();
      writeDailyDigest(store, registry, s, undefined, extras).catch((e: Error) => log.warn("digest failed:", e.message));
    }
  };

  const stop = await chain.subscribeBlocks(onBlock);
  const shutdown = async () => {
    log.info("shutting down…");
    stop();
    extras.fb?.stop();
    extras.liq?.saveBorrowers(await chain.blockNumber().catch(() => 0));
    await writeDailyReport(store, registry, s, undefined, extras).catch(() => undefined);
    await writeDailyDigest(store, registry, s, undefined, extras).catch(() => undefined);
    await chain.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
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
  registry.blacklist = s.tokenBlacklist;
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
      default:
        console.log("usage: node dist/main.js [check|discover|scan|run|report|summary|digest]");
    }
  } finally {
    if (cmd !== "run") await chain.destroy();
  }
}

main().catch((err) => {
  log.error((err as Error).stack ?? String(err));
  process.exit(1);
});
