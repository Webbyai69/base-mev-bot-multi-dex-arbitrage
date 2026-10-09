/**
 * Pool value-score (src/learn.ts poolScore / topPools): a pool is worth watching in
 * proportion to its depth, amplified by how often money actually moves through it
 * (rivals' arbs + our own finds) and how big those spreads were. Decayed memory, so
 * it tracks the recent market; liquidity is supplied by the caller.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Learner } from "../dist/learn.js";

const now = Date.UTC(2026, 0, 1, 12, 0, 0);
const sym = (a) => a.slice(0, 6);
const P_HOT = "0x" + "a".repeat(40);
const P_QUIET = "0x" + "b".repeat(40);
const P_DEEP = "0x" + "c".repeat(40);

function mev(pools, over = {}) {
  return {
    kind: "mev", type: "arbitrage", block: 1, timestamp: "2026-01-01T12:00:00Z", txHash: "0x", txIndex: 0,
    sender: "0xe", bot: "0xr", pools, dexes: ["uniswap-v3"], tokens: ["0xa", "0xb"],
    profitToken: "0xa", profitTokenSymbol: "A", profitAmount: 1n, profitUsd: 5, priorityGwei: 1, ...over,
  };
}
const opp = (pools, over = {}) => ({
  id: "o1", block: 1, route: undefined, buyPool: pools[0], sellPool: pools[1],
  tokenIn: "0xweth", tokenMid: "0xusdc", netUsd: 2, profitUsd: 3, gasUsd: 0.01, ...over,
});

test("a pool rivals keep arbing outscores an equally-deep quiet pool", () => {
  const l = new Learner(null, {}, sym);
  for (let i = 0; i < 10; i++) l.onRivalArbs([mev([P_HOT])], now);
  const hot = l.poolScore(P_HOT, 100, now);
  const quiet = l.poolScore(P_QUIET, 100, now);
  assert.ok(hot.rivalRate >= 9, `rivalRate ${hot.rivalRate} should reflect ~10 arbs`);
  assert.equal(quiet.rivalRate, 0);
  assert.ok(hot.score > quiet.score, `hot ${hot.score} should beat quiet ${quiet.score}`);
});

test("a deep quiet pool keeps a liquidity baseline and scales with depth", () => {
  const l = new Learner(null, {}, sym);
  const shallow = l.poolScore(P_QUIET, 5, now);
  const deep = l.poolScore(P_DEEP, 50, now);
  assert.ok(shallow.score > 0, "a quiet pool is not zeroed out");
  assert.equal(deep.score, 50, "no activity -> score is just the liquidity base");
  assert.ok(deep.score > shallow.score);
});

test("signals decay: a pool arbed 6h ago scores below one arbed just now (1h half-life)", () => {
  const l = new Learner(null, { halfLifeMs: 60 * 60 * 1000 }, sym);
  for (let i = 0; i < 10; i++) l.onRivalArbs([mev([P_HOT])], now - 6 * 60 * 60 * 1000);
  for (let i = 0; i < 10; i++) l.onRivalArbs([mev([P_QUIET])], now);
  const old = l.poolScore(P_HOT, 100, now);
  const fresh = l.poolScore(P_QUIET, 100, now);
  assert.ok(old.rivalRate < fresh.rivalRate, `old ${old.rivalRate} < fresh ${fresh.rivalRate}`);
  assert.ok(old.score < fresh.score);
});

test("edge is captured from both rival profit and our own finds", () => {
  const l = new Learner(null, {}, sym);
  l.onRivalArbs([mev([P_HOT], { profitUsd: 20 })], now);
  l.onFound(opp([P_HOT, P_QUIET], { profitUsd: 10 }), now);
  const s = l.poolScore(P_HOT, 10, now);
  assert.ok(s.edgeUsd >= 29 && s.edgeUsd <= 31, `edgeUsd ${s.edgeUsd} should be ~30 (20 rival + 10 find)`);
  assert.ok(s.rivalRate >= 1 && s.foundRate >= 1);
});

test("topPools ranks by score and uses liqOf for depth", () => {
  const l = new Learner(null, {}, sym);
  for (let i = 0; i < 5; i++) l.onRivalArbs([mev([P_HOT])], now);
  l.onFound(opp([P_QUIET, P_DEEP]), now);
  const liq = (p) => (p === P_DEEP ? 1000 : 10);
  const top = l.topPools(liq, 5, now);
  assert.ok(top.length >= 2);
  assert.equal(top[0].pool, P_DEEP, "a very deep pool ranks first even on one find");
});
