/**
 * Dynamic priority-fee bidding (src/learn.ts evaluate): the bid scales with the
 * trade's profit (up to LIVE_MAX_BID_SHARE of it), and the LIVE_MAX_BID_GWEI
 * ceiling — not a flat 2 gwei — decides how hard a high-profit trade can bid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Learner } from "../dist/learn.js";

const now = Date.UTC(2026, 0, 1, 12, 0, 0);
const sym = (a) => a.slice(0, 6);
const ctx = { ethUsd: 3000, gasUnits: 260000, basePriorityGwei: 0.005, maxBidShare: 0.3 };

function mev(over = {}) {
  return {
    kind: "mev", type: "arbitrage", block: 1, timestamp: "2026-01-01T12:00:00Z", txHash: "0x", txIndex: 0,
    sender: "0xe", bot: "0xr", pools: ["0xp"], dexes: ["uniswap-v3"], tokens: ["0xa", "0xb"],
    profitToken: "0xa", profitTokenSymbol: "A", profitAmount: 1n, profitUsd: 20, priorityGwei: 10, ...over,
  };
}
const opp = (over = {}) => ({ id: "o1", block: 1, route: undefined, buyPool: "0xbuy", sellPool: "0xsell", tokenIn: "0xweth", tokenMid: "0xusdc", netUsd: 20, profitUsd: 20, gasUsd: 0.01, ...over });
// Fill the rival-fee ring for the trade's profit bucket so marketBid wants `gwei`.
const feedRivals = (l, gwei, profitUsd) => { for (let i = 0; i < 25; i++) l.onRivalArbs([mev({ priorityGwei: gwei, profitUsd })], now); };

test("a high-profit trade bids well above the old 2-gwei cap when the ceiling is raised", () => {
  const l = new Learner(null, { maxBidGwei: 25 }, sym);
  feedRivals(l, 10, 20); // rivals pay ~10 gwei on $10+ trades
  const ev = l.evaluate(opp({ netUsd: 20, profitUsd: 20 }), ctx, now);
  // 30% of $20 over a 260k-gas trade at $3000 ETH ≈ 7.7 gwei of headroom — above the old flat 2.
  assert.ok(ev.bidGwei > 2, `bid ${ev.bidGwei} should exceed the old 2-gwei cap`);
  assert.ok(ev.bidGwei <= 8, `bid ${ev.bidGwei} should still stay within ~30% of the profit`);
});

test("the bid scales down with a small-profit trade (never richer than the profit share)", () => {
  const l = new Learner(null, { maxBidGwei: 25 }, sym);
  feedRivals(l, 10, 0.3); // rivals bid high, but our profit is tiny
  const ev = l.evaluate(opp({ netUsd: 0.3, profitUsd: 0.3 }), ctx, now);
  assert.ok(ev.bidGwei < 0.5, `bid ${ev.bidGwei} should scale down with the small profit`);
});

test("the flat 2-gwei ceiling still flattens a high-profit bid when set low", () => {
  const l = new Learner(null, { maxBidGwei: 2 }, sym);
  feedRivals(l, 10, 20);
  const ev = l.evaluate(opp({ netUsd: 20, profitUsd: 20 }), ctx, now);
  assert.ok(ev.bidGwei <= 2.0001, `bid ${ev.bidGwei} should be capped at 2 gwei`);
});
