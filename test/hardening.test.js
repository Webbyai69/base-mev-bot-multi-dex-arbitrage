/**
 * Insurance against a frozen bot or dashboard: RPC calls time out instead of hanging, the
 * scan-loop watchdog moves past a stuck block, eth_call is counted by purpose, and the rival
 * leaderboard only credits arbitrage profit (with mispriced values left out).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chain, withPurpose } from "../dist/rpc.js";
import { Store } from "../dist/store.js";
import { marketSummary } from "../dist/classifier.js";
import { baseScenario } from "./mockchain.mjs";
import { setLogLevel } from "../dist/log.js";

setLogLevel("error");

test("an RPC endpoint that never answers fails the call within the deadline instead of hanging", async () => {
  const server = createServer(() => {
    /* accept the request, never answer */
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const c = new Chain(url, undefined, { timeoutMs: 300, minIntervalMs: 0 });
  const t0 = Date.now();
  await assert.rejects(c.blockNumber(), /timed out|timeout/i);
  const ms = Date.now() - t0;
  assert.ok(ms < 2500, `gave up after ${ms} ms`);
  assert.ok(c.usage().timeouts >= 1);
  await c.destroy();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

test("eth_call is counted by what it was for", async () => {
  const sc = baseScenario();
  await sc.c.listen();
  const c = new Chain(sc.c.url);
  await withPurpose("verify", () => c.multicall([{ target: "0xca11bde05977b3631167028862be2a173976ca11", callData: "0x42cbb15c" }]));
  await c.multicall([{ target: "0xca11bde05977b3631167028862be2a173976ca11", callData: "0x42cbb15c" }]);
  const u = c.usage();
  assert.equal(u.callsByPurpose.verify, 1);
  assert.equal(u.callsByPurpose.other, 1);
  await c.destroy();
  await sc.c.close();
});

test("the scan-loop watchdog reports a stuck block handler and lets the next block run", async () => {
  const sc = baseScenario();
  await sc.c.listen();
  const c = new Chain(sc.c.url);
  const seen = [];
  const stalls = [];
  let nextSeen;
  const second = new Promise((r) => (nextSeen = r));
  const stop = await c.subscribeBlocks(
    async (n) => {
      seen.push(n);
      if (seen.length === 1) await new Promise(() => {}); // hangs forever
      nextSeen();
    },
    100,
    { maxHandlerMs: 300, onStall: (n, ms) => stalls.push({ n, ms }) },
  );
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(stalls.length, 1, "the stuck handler was reported");
  assert.equal(stalls[0].n, seen[0]);
  sc.c.nextBlock();
  await Promise.race([second, new Promise((_, no) => setTimeout(() => no(new Error("next block never handled")), 6000))]);
  assert.equal(seen.length, 2);
  assert.equal(seen[1], seen[0] + 1);
  stop();
  await c.destroy();
  await sc.c.close();
});

test("the rival leaderboard credits arbitrage profit only, and leaves out mispriced values", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "arbbot-rivals-")));
  const base = { kind: "mev", block: 1, timestamp: "2026-10-10T12:00:00.000Z", tokens: ["0x4200000000000000000000000000000000000006"], dexes: ["aerodrome"], pools: [], costUsd: 0.01 };
  store.append("mev.jsonl", { ...base, type: "arbitrage", bot: "0xaaaa", sender: "0x01", profitUsd: 12.5 });
  store.append("mev.jsonl", { ...base, type: "arbitrage", bot: "0xaaaa", sender: "0x01", profitUsd: 2018 }); // mispriced
  store.append("mev.jsonl", { ...base, type: "sandwich", bot: "0xbbbb", sender: "0x02", profitUsd: 5497 }); // no arbitrage at all
  store.append("mev.jsonl", { ...base, type: "arbitrage", bot: "0xcccc", sender: "0x03", profitUsd: 3 });
  await new Promise((r) => setTimeout(r, 50));
  const [m] = await marketSummary(store, (a) => a, [], ["2026-10-10"], 1000);
  assert.deepEqual(m.bots.map((b) => b.bot), ["0xaaaa", "0xcccc"], "a sandwich-only address isn't on the arbitrage leaderboard");
  const a = m.bots[0];
  assert.equal(a.arbitrage, 2);
  assert.equal(a.profitUsd, 12.5, "the $2,018 value is past the sanity cap");
  assert.equal(a.unpricedTxs, 1);
  assert.equal(m.arbitrageProfitUsd, 15.5);
  assert.equal(m.sandwichTxs, 1);
});

test("every simulation of a scan goes out in one eth_call (Multicall3 under the state override)", async () => {
  const { PoolRegistry } = await import("../dist/pools.js");
  const { Scanner } = await import("../dist/scanner.js");
  const { GasEstimator } = await import("../dist/gas.js");
  const sc = baseScenario();
  await sc.c.listen();
  sc.c.activityBlock();
  const c = new Chain(sc.c.url);
  const r = new PoolRegistry(c);
  await r.discover({ minLiquidityWeth: 2, maxPools: 400, mode: "activity", lookbackBlocks: 5, logRange: 2 });
  // Open a second spread so the scan has more than one route to simulate.
  const memeUni = sc.c.pools.get("0xaaaa000000000000000000000000000000000005");
  memeUni.reserve1 = memeUni.reserve1 + memeUni.reserve1 / 10n;
  const n = sc.c.nextBlock();
  await r.refreshAll(n);
  const q = await new GasEstimator(c, 260_000, 0.005).quote(n, null);
  const scanner = new Scanner(c, r);
  const before = sc.c.requests.filter((m) => m === "eth_call").length;
  const opps = await scanner.scan(n, q, r.ethPrice(), 0.01);
  const calls = sc.c.requests.filter((m) => m === "eth_call").length - before;
  assert.ok(opps.length >= 2, `${opps.length} finds`);
  assert.ok(opps.every((o) => o.sim === "executor-ok"), opps.map((o) => o.simDetail).join("; "));
  assert.equal(calls, 1, "one request for all simulations");
  await c.destroy();
  await sc.c.close();
});
