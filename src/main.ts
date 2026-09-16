/**
 * Entry point / CLI.
 *
 *   node dist/main.js check      verify RPC + every configured address
 *   node dist/main.js discover   (re)build the pool watch list -> data/pools.json
 *   node dist/main.js scan       one-shot: print the best routes right now
 *   node dist/main.js run        the bot loop (paper or live per .env)  [default]
 *   node dist/main.js report     regenerate today's HTML report
 *   node dist/main.js summary    print paper-trading and market summaries
 */
import { loadSettings, type Settings } from "./config.js";
import { Chain } from "./rpc.js";
import { PoolRegistry, type PoolSnapshot } from "./pools.js";
import { Scanner } from "./scanner.js";
import { GasEstimator } from "./gas.js";
import { Store } from "./store.js";
import { PaperEngine, summarize } from "./paper.js";
import { Classifier, fetchFullBlock, marketSummary } from "./classifier.js";
import { renderReport, writeReport } from "./report.js";
import { LiveExecutor } from "./executor.js";
import { runCheck } from "./check.js";
import { log, setLogLevel } from "./log.js";
import { formatUnits } from "./math.js";

const POOLS_FILE = "pools.json";

async function loadOrDiscover(registry: PoolRegistry, store: Store, s: Settings, force = false): Promise<void> {
  const snap = force ? undefined : store.readJson<PoolSnapshot>(POOLS_FILE);
  if (snap && snap.version === 1 && snap.pools.length > 0) {
    registry.loadSnapshot(snap);
    log.info(`loaded ${registry.pools.size} pools from ${store.path(POOLS_FILE)} (discovered ${snap.discoveredAt}); run "discover" to rebuild`);
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

async function writeDailyReport(store: Store, registry: PoolRegistry, s: Settings, day = new Date().toISOString().slice(0, 10)): Promise<string> {
  const [paper, market] = await Promise.all([summarize(store, [day]), marketSummary(store, (a) => registry.symbol(a), s.watchBots, [day])]);
  const html = renderReport(day, paper[0], market[0], {
    mode: s.mode,
    pools: registry.pools.size,
    pairs: [...registry.groups().values()].filter((g) => g.length >= 2).length,
    ethUsd: registry.pools.size ? registry.ethPrice() : 0,
  });
  return writeReport(s.reportDir, day, html);
}

async function run(s: Settings, chain: Chain, registry: PoolRegistry, store: Store): Promise<void> {
  await loadOrDiscover(registry, store, s);
  const scanner = new Scanner(chain, registry, s.executorAddress, s.simOverride);
  log.info(`on-chain verification: ${scanner.simMode}${scanner.simMode === "override" ? " (ArbExecutor bytecode injected via eth_call state override; no deployment needed)" : ""}`);
  const gas = new GasEstimator(chain, s.arbGasLimit, s.priorityFeeGwei);
  const paper = new PaperEngine(store, registry);
  const classifier = s.mevFeed ? new Classifier(chain, registry, store) : undefined;
  const live =
    s.mode === "live"
      ? new LiveExecutor(chain, store, s.privateKey!, s.executorAddress!, {
          gasLimit: s.arbGasLimit,
          priorityFeeGwei: s.priorityFeeGwei,
          maxDailyGasUsd: Number(process.env.MAX_DAILY_GAS_USD ?? 20),
          useFlash: (process.env.USE_FLASH ?? "true") !== "false",
        })
      : undefined;
  if (live) log.warn(`LIVE MODE: sending from ${live.wallet.address} via executor ${s.executorAddress}. Create ${store.path("STOP")} to halt.`);

  let lastReport = 0;
  let blocksSeen = 0;
  const t0 = Date.now();

  const onBlock = async (n: number): Promise<void> => {
    const started = Date.now();
    // One block fetch serves the gas estimator (base fee) and the classifier (tx senders).
    const [blk] = await Promise.all([fetchFullBlock(chain, n), registry.refreshAll(n)]);
    const baseFee = blk?.baseFeePerGas ? BigInt(blk.baseFeePerGas) : null;
    const ethUsd = registry.ethPrice();
    const [gasQuote, detected] = await Promise.all([
      gas.quote(n, baseFee),
      classifier ? classifier.classifyBlock(n, ethUsd, blk).catch((e: Error) => (log.warn("classifier failed:", e.message.slice(0, 120)), [])) : Promise.resolve([]),
    ]);
    const opps = await scanner.scan(n, gasQuote, ethUsd, s.minProfitUsd);
    paper.onBlock(n, opps, detected, ethUsd);
    if (live && opps[0]) live.trySend(opps[0], ethUsd);

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
      log.info(`block ${n}: ${registry.pools.size} pools, ${opps.length} opps, ${detected.length} mev txs, ${ms}ms, gas/tx $${((Number(gasQuote.totalWei) / 1e18) * ethUsd).toFixed(4)}, uptime ${((Date.now() - t0) / 60000).toFixed(0)}m`);
    }
    if (Date.now() - lastReport > 60_000) {
      lastReport = Date.now();
      writeDailyReport(store, registry, s).catch((e: Error) => log.warn("report failed:", e.message));
    }
  };

  const stop = await chain.subscribeBlocks(onBlock);
  const shutdown = async () => {
    log.info("shutting down…");
    stop();
    await writeDailyReport(store, registry, s).catch(() => undefined);
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
  const scanner = new Scanner(chain, registry, s.executorAddress, s.simOverride);
  const raw = scanner.findRaw();
  const opps = await scanner.scan(n, gasQuote, ethUsd, -Infinity);
  console.log(`block ${n} · ETH $${ethUsd.toFixed(2)} · est. gas per arb $${((Number(gasQuote.totalWei) / 1e18) * ethUsd).toFixed(4)} · ${raw.length} positive-spread routes before gas`);
  if (opps.length === 0) {
    console.log("no priced routes right now (spreads are inside the fees or the token cannot be priced)");
    return;
  }
  for (const o of opps.slice(0, 15)) {
    const dec = registry.token(o.tokenIn)?.decimals ?? 18;
    console.log(
      `${o.netUsd >= 0 ? "+" : ""}${o.netUsd.toFixed(4)} USD net  ${o.pairSymbols.padEnd(16)} buy ${o.buyDex.padEnd(12)} sell ${o.sellDex.padEnd(12)} in ${formatUnits(o.amountIn, dec, 5)} ${o.tokenInSymbol}  profit $${o.profitUsd.toFixed(4)}  sim=${o.sim}${o.simDetail ? ` (${o.simDetail})` : ""}`,
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
  }
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
  const chain = new Chain(s.rpcUrl, s.wsUrl, {
    ...(s.rpcConcurrency !== undefined ? { concurrency: s.rpcConcurrency } : {}),
    ...(s.rpcMinIntervalMs !== undefined ? { minIntervalMs: s.rpcMinIntervalMs } : {}),
    ...(s.rpcBatchMaxCount !== undefined ? { batchMaxCount: s.rpcBatchMaxCount } : {}),
  });
  log.info(`rpc ${s.rpcUrl.replace(/\/v2\/.*|\/[0-9a-f]{20,}.*/i, "/…")} · concurrency ${chain.opts.concurrency}, min interval ${chain.opts.minIntervalMs}ms, batch ${chain.opts.batchMaxCount}`);
  const registry = new PoolRegistry(chain);
  try {
    switch (cmd) {
      case "check": {
        const ok = await runCheck(chain);
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
        console.log("usage: node dist/main.js [check|discover|scan|run|report|summary]");
    }
  } finally {
    if (cmd !== "run") await chain.destroy();
  }
}

main().catch((err) => {
  log.error((err as Error).stack ?? String(err));
  process.exit(1);
});
