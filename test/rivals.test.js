/**
 * Per-wallet rival memory (src/learn.ts): the bot remembers where/when/how real
 * competitors trade, excludes its own trades, and ignores shared routers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Learner } from "../dist/learn.js";

const HOUR14 = Date.UTC(2026, 0, 1, 14, 0, 0);
const sym = (a) => ({ "0xweth": "WETH", "0xusdc": "USDC", "0xdegen": "DEGEN" })[a] ?? a.slice(0, 6);

function mev(over = {}) {
  return {
    kind: "mev", type: "arbitrage", block: 1, timestamp: "2026-01-01T14:00:00Z",
    txHash: "0xtx", txIndex: 0, sender: "0xeoa1", bot: "0xbota",
    pools: ["0xpool1"], dexes: ["uniswap-v3"], tokens: ["0xweth", "0xusdc"],
    profitToken: "0xweth", profitTokenSymbol: "WETH", profitAmount: 1n, profitUsd: 1.5,
    priorityGwei: 0.1, ...over,
  };
}

test("records a per-wallet profile for a real competitor", () => {
  const l = new Learner(null, {}, sym);
  l.onRivalArbs([mev({ pools: ["0xpool1"], tokens: ["0xweth", "0xusdc"], priorityGwei: 0.1, profitUsd: 1 })], HOUR14);
  l.onRivalArbs([mev({ pools: ["0xpool1"], tokens: ["0xweth", "0xdegen"], priorityGwei: 0.3, profitUsd: 2 })], HOUR14);
  l.onRivalArbs([mev({ pools: ["0xpool2"], tokens: ["0xweth", "0xusdc"], priorityGwei: 0.2, profitUsd: 3 })], HOUR14);
  const { rivals } = l.summary(HOUR14);
  assert.equal(rivals.length, 1);
  const r = rivals[0];
  assert.equal(r.bot, "0xbota");
  assert.equal(r.arbs, 3);
  assert.equal(r.profitUsd, 6);
  assert.equal(r.topPools[0], "0xpool1"); // hit twice -> ranked first
  assert.deepEqual([...r.topTokens].sort(), ["DEGEN", "USDC", "WETH"]); // symbolized
  assert.equal(r.medianFeeGwei, 0.2);
  assert.equal(r.peakHourUtc, 14);
});

test("the bot's own trades are never tracked as a rival", () => {
  const l = new Learner(null, {}, sym);
  l.setSelf(["0xbota"]);
  l.onRivalArbs([mev({ bot: "0xbota" })], HOUR14);
  assert.equal(l.summary(HOUR14).rivals.length, 0);
});

test("a shared router (many distinct senders) is excluded from the rival list", () => {
  const l = new Learner(null, {}, sym);
  for (let i = 0; i < 6; i++) l.onRivalArbs([mev({ bot: "0xrouter", sender: "0xeoa" + i })], HOUR14);
  l.onRivalArbs([mev({ bot: "0xbot1", sender: "0xeoaX" })], HOUR14);
  const rivals = l.summary(HOUR14).rivals.map((r) => r.bot);
  assert.ok(rivals.includes("0xbot1"));
  assert.ok(!rivals.includes("0xrouter"));
});
