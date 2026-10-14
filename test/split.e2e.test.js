/**
 * Split trades end to end on the in-memory mock chain (test/mockchain.mjs):
 * discovery -> Scanner.scan with SPLIT_TRADES on -> per-leg quoter
 * verification over Multicall3 -> PaperEngine re-pricing and outcome ->
 * daily summary. Also pins the safety properties: splits never reach the live
 * path, never displace the executable classic route, and don't teach the
 * learning engine.
 *
 * Needs the npm dependencies (ethers) like test/e2e.test.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseScenario } from "./mockchain.mjs";
import { Chain } from "../dist/rpc.js";
import { PoolRegistry } from "../dist/pools.js";
import { Scanner, routeKey, poolsOf } from "../dist/scanner.js";
import { GasEstimator } from "../dist/gas.js";
import { Store } from "../dist/store.js";
import { PaperEngine, summarize, strategyKind } from "../dist/paper.js";
import { pickLiveOpportunity } from "../dist/executor.js";
import { splitSettings } from "../dist/config.js";
import { setLogLevel } from "../dist/log.js";

setLogLevel("error");
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

let sc, chain, registry;

before(async () => {
  sc = baseScenario();
  await sc.c.listen();
  sc.c.activityBlock();
  chain = new Chain(sc.c.url);
  registry = new PoolRegistry(chain);
  await registry.discover({ minLiquidityWeth: 2, maxPools: 400, mode: "activity", lookbackBlocks: 5, logRange: 2 });
});

after(async () => {
  await chain.destroy();
  await sc.c.close();
});

test("SPLIT_TRADES setting: off unless set, read from the environment lazily", () => {
  const prev = process.env.SPLIT_TRADES;
  delete process.env.SPLIT_TRADES;
  assert.equal(splitSettings().enabled, false);
  process.env.SPLIT_TRADES = "true";
  assert.equal(splitSettings().enabled, true);
  if (prev === undefined) delete process.env.SPLIT_TRADES;
  else process.env.SPLIT_TRADES = prev;
});

test("paper mode: a split is found next to the classic route, verified quoter-ok leg by leg, re-priced and finalized", async () => {
  const gasEst = new GasEstimator(chain, 260_000, 0.005);
  let n = sc.c.block;
  await registry.refreshAll(n);
  const ethUsd = registry.ethPrice();

  // Without splits: exactly the classic route, as in test/e2e.test.js.
  const plain = new Scanner(chain, registry, undefined, false);
  plain.splitCfg = { enabled: false, onFlashblocks: false, maxPoolsPerPair: 8, maxMs: 50 };
  const baseline = await plain.scan(n, await gasEst.quote(n, null), ethUsd, 0.01);

  const scanner = new Scanner(chain, registry, undefined, false); // quoter verification path
  scanner.splitCfg = { enabled: true, onFlashblocks: false, maxPoolsPerPair: 8, maxMs: 50 };
  const opps = await scanner.scan(n, await gasEst.quote(n, null), ethUsd, 0.01);
  const classic = opps.filter((o) => !o.split);
  const splits = opps.filter((o) => o.split);

  // The executable classic route is untouched by the split sharing its pools.
  assert.deepEqual(classic.map((o) => o.id), baseline.map((o) => o.id));
  assert.equal(classic[0].sim, "quoter-ok", classic[0].simDetail);

  assert.equal(splits.length, 1);
  const sp = splits[0];
  assert.equal(sp.sim, "quoter-ok", sp.simDetail);
  assert.match(sp.pairSymbols, /^(WETH\/USDC split 1>3|USDC\/WETH split 3>1)$/);
  assert.equal(sp.hops, 4);
  assert.equal(sp.route, undefined);
  assert.ok(sp.netUsd > classic[0].netUsd, `split net ${sp.netUsd} should beat the classic route's ${classic[0].netUsd}`);
  assert.equal(poolsOf(sp).length, 4);
  assert.match(routeKey(sp), /^split:/);
  assert.notEqual(routeKey(sp), routeKey(classic[0]));

  // Never live: the live picker only takes executor-ok classic routes.
  assert.equal(pickLiveOpportunity(splits), undefined);
  assert.ok(!sp.sim.startsWith("executor"));

  // Paper: register, nobody takes it, still there at N+1 -> persisted; no learner callback for the split.
  const store = new Store(mkdtempSync(join(tmpdir(), "arbbot-split-")));
  const paper = new PaperEngine(store, registry);
  const taught = [];
  paper.onOutcome = (o) => taught.push(o.id);
  paper.onBlock(n, opps, [], ethUsd);
  n = sc.c.nextBlock();
  await registry.refreshAll(n);
  paper.onBlock(n, [], [], ethUsd);
  n = sc.c.nextBlock();
  await registry.refreshAll(n);
  paper.onBlock(n, [], [], ethUsd);
  assert.ok(!taught.includes(sp.id), "splits must not teach the learning engine");
  assert.ok(taught.includes(classic[0].id));
  const [day] = await summarize(store);
  const kind = day.byKind.find((k) => k.key === strategyKind(sp));
  assert.ok(kind, "split strategy row in the summary");
  assert.equal(kind.found, 1);
  assert.equal(kind.persisted, 1);
  assert.ok(day.byRoute.some((r) => r.route.includes("+")), "split route label lists the leg DEXes");
});

test("re-pricing: a rival closes Aerodrome's spread at N+1 -> the split is closed", async () => {
  const gasEst = new GasEstimator(chain, 260_000, 0.005);
  sc.c.setReserves(sc.aeroWethUsdc.address, 50n * E18, 105_000n * E6);
  let n = sc.c.nextBlock();
  await registry.refreshAll(n);
  const ethUsd = registry.ethPrice();
  const scanner = new Scanner(chain, registry, undefined, false);
  scanner.splitCfg = { enabled: true, onFlashblocks: false, maxPoolsPerPair: 8, maxMs: 50 };
  const opps = await scanner.scan(n, await gasEst.quote(n, null), ethUsd, 0.01);
  const sp = opps.find((o) => o.split);
  assert.ok(sp);
  const store = new Store(mkdtempSync(join(tmpdir(), "arbbot-split-")));
  const paper = new PaperEngine(store, registry);
  paper.onBlock(n, [sp], [], ethUsd);
  // Aerodrome back in line with the others: nothing left to split.
  sc.c.setReserves(sc.aeroWethUsdc.address, 51n * E18 + E18 / 4n, 102_500n * E6);
  n = sc.c.nextBlock();
  await registry.refreshAll(n);
  paper.onBlock(n, [], [], ethUsd);
  n = sc.c.nextBlock();
  await registry.refreshAll(n);
  paper.onBlock(n, [], [], ethUsd);
  const [day] = await summarize(store);
  assert.equal(day.closed, 1);
});
