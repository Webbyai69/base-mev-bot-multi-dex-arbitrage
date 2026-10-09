/**
 * Leaderboard de-masking (src/classifier.ts marketSummary): an address called by
 * many distinct EOAs is a shared router/aggregator (e.g. the V4 Universal Router),
 * not one competitor, so it is flagged and kept out of the top-bots list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketSummary } from "../dist/classifier.js";

function fakeStore(records) {
  return {
    read: async function* () {
      for (const r of records) yield r;
    },
  };
}

function mev(over = {}) {
  return {
    kind: "mev", type: "arbitrage", block: 100, timestamp: "2026-01-01T10:00:00Z",
    txHash: "0xtx", txIndex: 0, sender: "0xeoa1", bot: "0xbot1",
    pools: ["0xp1", "0xp2"], dexes: ["uniswap-v3", "aerodrome"], tokens: ["0xweth", "0xusdc"],
    profitToken: "0xweth", profitTokenSymbol: "WETH", profitAmount: 1n, profitUsd: 2,
    costUsd: 0.01, priorityGwei: 0.1, ...over,
  };
}

test("a shared router is kept out of top bots and captured in routers", async () => {
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push(mev({ bot: "0xrouter", sender: "0xeoa" + i, profitUsd: 100 })); // 6 distinct EOAs
  for (let i = 0; i < 3; i++) recs.push(mev({ bot: "0xbot1", sender: "0xsolo", profitUsd: 5 })); //      one EOA
  const [day] = await marketSummary(fakeStore(recs), (a) => a, []);

  const botAddrs = day.bots.map((b) => b.bot);
  assert.ok(botAddrs.includes("0xbot1"), "the real bot is shown");
  assert.ok(!botAddrs.includes("0xrouter"), "the router is hidden from the top-bots list");

  const router = day.routers.find((b) => b.bot === "0xrouter");
  assert.ok(router, "the router is captured in the routers list");
  assert.equal(router.shared, true);
  assert.ok(router.senders >= 5);

  const bot1 = day.bots.find((b) => b.bot === "0xbot1");
  assert.equal(bot1.shared, false);
  assert.equal(bot1.senders, 1);
});
