/**
 * The learning engine (src/learn.ts) and dashboard tuning: decay, skipping what
 * keeps failing (with re-tests), P(land) and expected value, learned bids,
 * pool pruning, warm start from the data files, persistence, and the bounded
 * Apply / Dismiss / Reset flow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Learner, Tuning, parseReviewSuggestions } from "../dist/learn.js";
import { pickLiveSend, summarizeLive } from "../dist/executor.js";
import { renderDigest } from "../dist/digest.js";
import { Store } from "../dist/store.js";

const HOUR = 3_600_000;
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BAD = "0xbad0000000000000000000000000000000000001";
const GOOD = "0x900d000000000000000000000000000000000002";
let n = 0;
const pool = () => "0x" + (++n).toString(16).padStart(40, "a");

function opp(tokenMid, over = {}) {
  const buyPool = over.buyPool ?? pool();
  const sellPool = over.sellPool ?? pool();
  return {
    id: `o${++n}`, block: 100, foundAt: new Date().toISOString(), pair: `${WETH}-${tokenMid}`, pairSymbols: `WETH/${tokenMid === BAD ? "BAD" : "GOOD"}`,
    buyPool, buyDex: "uniswap-v2", sellPool, sellDex: "aerodrome", tokenIn: WETH, tokenInSymbol: "WETH", tokenMid,
    amountIn: 10n ** 17n, amountMid: 1n, amountOut: 2n, profit: 10n ** 15n, profitUsd: 1, gasUsd: 0.01, netUsd: 0.99, sim: "executor-ok", hops: 2, ...over,
  };
}
const sym = (a) => (a === BAD ? "BAD" : a === GOOD ? "GOOD" : a.slice(0, 6));

test("evidence halves every half-life", () => {
  const L = new Learner(null, { halfLifeMs: 10 * HOUR }, sym);
  const t0 = Date.now();
  const o = opp(BAD, { sim: "executor-revert", simDetail: "TransferFailed()" });
  for (let i = 0; i < 8; i++) L.onSim(o, t0);
  const now = L.summary(t0).skipping[0];
  const later = L.summary(t0 + 10 * HOUR).skipping;
  assert.equal(now.n, 8);
  assert.ok(later.length === 1 && Math.abs(later[0].n - 4) < 0.01, "8 failures count as 4 one half-life later");
});

test("a token that keeps failing is skipped before testing, and re-tested every few hours", () => {
  const L = new Learner(null, { retestMs: 6 * HOUR }, sym);
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) L.onSim(opp(BAD, { sim: "executor-revert", simDetail: "TransferFailed()" }), t0);
  const fresh = opp(BAD); // a new route through the same token
  assert.match(L.skipReason(fresh, t0 + HOUR), /BAD failed \d+% of 5 test runs/);
  assert.equal(L.skipReason(fresh, t0 + 7 * HOUR), null, "after the re-test interval one test run goes through");
  // The re-test passes several times: the token is trusted again.
  for (let i = 0; i < 6; i++) L.onSim(opp(BAD, { sim: "executor-ok" }), t0 + 7 * HOUR);
  assert.equal(L.skipReason(opp(BAD), t0 + 7.5 * HOUR), null);
  // Core tokens are never blamed: a failing WETH/USDC route blames its pools instead.
  const a = pool();
  for (let i = 0; i < 6; i++) L.onSim(opp(USDC, { buyPool: a, sim: "executor-revert" }), t0);
  assert.match(L.skipReason(opp(USDC, { buyPool: a }), t0 + HOUR), /pool/);
  assert.equal(L.skipReason(opp(USDC), t0 + HOUR), null, "other WETH/USDC pools are unaffected");
  // Tokens you blocked on the dashboard are skipped whatever the record says.
  assert.match(L.skipReason(opp(GOOD), t0, new Set([GOOD])), /blocked/);
});

test("P(land) and expected value follow the route's record; rival-dominated routes aren't sent", () => {
  const L = new Learner(null, {}, sym);
  const t0 = Date.now();
  const win = opp(GOOD);
  const lose = opp(GOOD);
  for (let i = 0; i < 6; i++) {
    L.onOutcome({ ...win, id: `w${i}` }, "persisted", undefined, t0);
    L.onOutcome({ ...lose, id: `l${i}` }, "taken", "0xrival", t0);
  }
  const ctx = { ethUsd: 2500, gasUnits: 260_000, basePriorityGwei: 0.005, maxBidShare: 0.3, evMinUsd: 0.01 };
  const ew = L.evaluate(win, ctx, t0);
  const el = L.evaluate(lose, ctx, t0);
  assert.ok(ew.pLand > 0.7, `winning route lands ${ew.pLand}`);
  assert.ok(el.pLand < 0.3, `losing route lands ${el.pLand}`);
  assert.ok(ew.evUsd > 0.5 && el.evUsd < ew.evUsd);
  // A small net on a route that always loses: negative expected value.
  const tiny = { ...lose, profitUsd: 0.03, netUsd: 0.02, gasUsd: 0.01 };
  assert.ok(L.evaluate(tiny, ctx, t0).evUsd < 0);
  const pick = pickLiveSend([tiny, { ...win, route: { pools: [] } }, { ...win, id: "unverified", sim: "executor-revert" }, win], L, ctx);
  assert.equal(pick.send?.o.id, win.id, "the verified two-pool find with the best expected value");
  assert.ok(pick.passed.some((x) => x.o === tiny));
  // A route it has never seen starts from what similar routes do.
  assert.ok(Math.abs(L.pLand(opp(GOOD), t0).p - 0.5) < 0.01);
});

test("bids follow what rivals pay, rise after lost races, fall after wins, never past the cap", () => {
  const L = new Learner(null, { maxBidGwei: 2 }, sym);
  const t0 = Date.now();
  const rivals = Array.from({ length: 50 }, (_, i) => ({ type: "arbitrage", pools: [pool()], priorityGwei: 0.01 + i * 0.0002, profitUsd: 1 }));
  L.onRivalArbs(rivals, t0);
  const o = opp(GOOD);
  const ctx = { ethUsd: 2500, gasUnits: 260_000, basePriorityGwei: 0.005, maxBidShare: 0.3, evMinUsd: 0 };
  const first = L.evaluate(o, ctx, t0);
  assert.ok(first.bidGwei > 0.015 && first.bidGwei < 0.022, `bid near rivals' 60th percentile: ${first.bidGwei}`);
  assert.match(first.bidWhy, /p60/);
  // We sent, it reverted, and a rival took the same trade: a lost race, so bid more next time.
  L.onLive(o, "reverted", 0.01, first.bidGwei, t0);
  L.onOutcome(o, "taken", "0xrival", t0);
  const second = L.evaluate(o, ctx, t0);
  assert.ok(second.bidGwei > first.bidGwei * 1.4, `raised after a lost race: ${second.bidGwei}`);
  L.onLive(o, "success", 0.01, second.bidGwei, t0);
  assert.ok(L.evaluate(o, ctx, t0).bidGwei < second.bidGwei, "eased off after a win");
  // The cap: never more than maxBidShare of the expected profit.
  const small = { ...opp(GOOD), profitUsd: 0.05, netUsd: 0.04 };
  const big = L.evaluate(small, { ...ctx, maxBidShare: 0.1 }, t0);
  const usdPerGwei = (260_000 * 1e9 * 2500) / 1e18;
  assert.ok((big.bidGwei - 0.005) * usdPerGwei <= 0.1 * 0.05 + 1e-9, `extra tip cost within 10% of profit: ${big.bidGwei}`);
});

test("pools with no swaps, finds or rival trades for days are dropped; core pricing pools never", () => {
  const L = new Learner(null, { pruneAfterMs: 72 * HOUR }, sym);
  const t0 = Date.now();
  const quiet = { address: pool(), token0: WETH, token1: GOOD };
  const busy = { address: pool(), token0: WETH, token1: GOOD };
  const core = { address: pool(), token0: WETH, token1: USDC };
  L.track([quiet.address, busy.address, core.address], t0);
  assert.deepEqual(L.pruneList([quiet, busy, core], t0 + 10 * HOUR), [], "nothing is dropped within the first period");
  L.onPoolActivity([busy.address], t0 + 70 * HOUR);
  const out = L.pruneList([quiet, busy, core], t0 + 80 * HOUR);
  assert.deepEqual(out, [quiet.address]);
  L.notePruned(out);
  assert.equal(L.summary(t0 + 80 * HOUR).pools.prunedTotal, 1);
  // A rival trading it again brings it back into consideration.
  L.onRivalArbs([{ type: "arbitrage", pools: [quiet.address] }], t0 + 81 * HOUR);
  assert.deepEqual(L.pruneList([quiet], t0 + 82 * HOUR), []);
});

test("time the bot was off doesn't count toward pruning, and a first start watches for a full period", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prune-"));
  const store = new Store(dir);
  const t0 = Date.now();
  // Old data: a rival traded this pool five days ago, before swaps were being watched.
  const p = { address: pool(), token0: WETH, token1: GOOD };
  writeFileSync(join(dir, "mev.jsonl"), JSON.stringify({ kind: "mev", type: "arbitrage", pools: [p.address], priorityGwei: 0.02, profitUsd: 3, timestamp: new Date(t0 - 120 * HOUR).toISOString() }) + "\n");
  const L = new Learner(store, { pruneAfterMs: 72 * HOUR }, sym);
  assert.equal(await L.load(t0), "warm-start");
  assert.deepEqual(L.pruneList([p], t0 + 2 * HOUR), [], "the quiet clock starts at the first start, not at the old data");
  L.save(true);
  // The PC was off for 100 hours: on the next start that time doesn't count.
  const again = new Learner(store, { pruneAfterMs: 72 * HOUR }, sym);
  assert.equal(await again.load(t0 + 100 * HOUR), "loaded");
  assert.deepEqual(again.pruneList([p], t0 + 101 * HOUR), []);
  assert.deepEqual(again.pruneList([p], t0 + 175 * HOUR), [p.address], "72 watched hours with nothing happening");
});

test("the bot's own trades are its own results, not a rival's win or a price to bid against", () => {
  const EXEC = "0xfd9330a418f19e943a579141cf7f111fba2592a6";
  const L = new Learner(null, {}, sym);
  L.setSelf(["0xFD9330A418F19E943A579141CF7F111FBA2592A6", undefined]);
  const t0 = Date.now();
  const o = opp(GOOD);
  L.onLive(o, "success", 0.01, 0.005, t0);
  L.onOutcome(o, "taken", EXEC, t0);
  const row = L.summary(t0).routes.find((r) => r.key.startsWith(o.buyPool));
  assert.equal(row.topRival, null, "not listed as a rival");
  assert.equal(row.takenShare, null, "not counted as taken");
  assert.ok(L.pLand(o, t0).p > 0.9, "its own landed trade counts for the route");
  L.onRivalArbs(Array.from({ length: 30 }, () => ({ type: "arbitrage", bot: EXEC, pools: [pool()], priorityGwei: 1.5, profitUsd: 1 })), t0);
  assert.equal(L.marketBid(1).samples, 0, "its own bids don't set the market rate");
});

test("warm start learns from the existing data files, and the memory survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "learn-"));
  const o1 = opp(BAD, { sim: "executor-revert", simDetail: "TransferFailed()" });
  const lines = [];
  for (let i = 0; i < 6; i++) lines.push(JSON.stringify({ ...o1, id: `x${i}`, kind: "opportunity", amountIn: "1", amountMid: "1", amountOut: "2", profit: "1" }));
  const o2 = opp(GOOD);
  lines.push(JSON.stringify({ ...o2, kind: "opportunity", amountIn: "1", amountMid: "1", amountOut: "2", profit: "1" }));
  lines.push(JSON.stringify({ kind: "outcome", id: o2.id, status: "taken", takenBy: "0xrival", finalizedAt: new Date().toISOString() }));
  writeFileSync(join(dir, "opportunities.jsonl"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "mev.jsonl"), JSON.stringify({ kind: "mev", type: "arbitrage", pools: [pool()], priorityGwei: 0.02, profitUsd: 3, timestamp: new Date().toISOString() }) + "\n");
  const store = new Store(dir);
  const L = new Learner(store, {}, sym);
  assert.equal(await L.load(), "warm-start");
  const s = L.summary();
  assert.equal(s.counts.sims, 7);
  assert.equal(s.counts.rivalArbs, 1);
  assert.equal(s.skipping[0].sym, "BAD");
  L.save(true);
  const again = new Learner(store, {}, sym);
  assert.equal(await again.load(), "loaded");
  assert.equal(again.summary().counts.sims, 7);
  assert.match(again.skipReason(opp(BAD)) ?? "", /BAD/);
});

test("tuning: the bot suggests, you apply within limits, dismiss for a week, or reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "tune-"));
  const store = new Store(dir);
  const L = new Learner(null, {}, sym);
  for (let i = 0; i < 12; i++) L.onSim(opp(BAD, { sim: "executor-revert", simDetail: "TransferFailed()" }));
  const routes = Array.from({ length: 6 }, () => opp(GOOD));
  for (const o of routes) L.onLive(o, "reverted", 0.01, 0.005);
  const T = new Tuning(store, { minProfitUsd: 0.25, maxBidShare: 0.3, evMinUsd: 0.01 });
  const sug = T.refresh(L, null);
  const block = sug.find((x) => x.key === "blockToken");
  const raise = sug.find((x) => x.key === "minProfitUsd");
  assert.ok(block && block.value === BAD, "suggests blocking the token that always fails");
  assert.ok(raise && raise.value === 0.5, "suggests a higher minimum after most live sends failed");
  assert.deepEqual(T.act("apply", block.id), { ok: true, blockedToken: BAD });
  assert.ok(T.blocked.has(BAD));
  assert.equal(T.act("apply", raise.id).ok, true);
  assert.equal(T.minProfitUsd, 0.5);
  // Saved and reloaded, with limits re-checked on load.
  const reloaded = new Tuning(store, { minProfitUsd: 0.25, maxBidShare: 0.3, evMinUsd: 0.01 });
  assert.equal(reloaded.minProfitUsd, 0.5);
  writeFileSync(join(dir, "tuning.json"), JSON.stringify({ v: 1, values: { minProfitUsd: 99, maxBidShare: 0.9 }, blockedTokens: {}, applied: [], dismissed: {} }));
  const tampered = new Tuning(store, { minProfitUsd: 0.25, maxBidShare: 0.3, evMinUsd: 0.01 });
  assert.equal(tampered.minProfitUsd, 0.25, "an out-of-range value in the file is ignored");
  assert.equal(tampered.maxBidShare, 0.3);
  // Dismissed suggestions stay hidden.
  const T2 = new Tuning(null, { minProfitUsd: 0.25, maxBidShare: 0.3, evMinUsd: 0.01 });
  const s2 = T2.refresh(L, null);
  const first = s2[0];
  assert.equal(T2.act("dismiss", first.id).ok, true);
  assert.ok(!T2.refresh(L, null).some((x) => x.id === first.id));
  assert.equal(T2.act("apply", "nope").ok, false);
  // Reset goes back to .env.
  assert.equal(T.act("reset").ok, true);
  assert.equal(T.minProfitUsd, 0.25);
  assert.equal(T.blocked.size, 0);
});

test("the AI review can suggest changes in a json block; only known settings within limits get through", () => {
  const T = new Tuning(null, { minProfitUsd: 0.25, maxBidShare: 0.3, evMinUsd: 0.01 });
  const text = 'Review…\n```json\n{"suggestions": [{"key": "minProfitUsd", "value": 0.4, "why": "fewer reverts"}, {"key": "MODE", "value": 1}, {"key": "maxBidShare", "value": 0.9}, {"key": "evMinUsd", "value": "x"}]}\n```\n';
  const s = parseReviewSuggestions(text, T);
  assert.equal(s.length, 1);
  assert.equal(s[0].key, "minProfitUsd");
  assert.equal(s[0].value, 0.4);
  assert.equal(s[0].source, "ai-review");
  assert.deepEqual(parseReviewSuggestions("no json here", T), []);
});

test("the digest reports live sends per day, with gas and the safety rails, for the daily review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-"));
  const t = new Date().toISOString();
  const base = { kind: "live", block: 1, sentAt: t };
  const recs = [
    { ...base, id: "a", txHash: "0xa", status: "pending", priorityFeeGwei: 0.005, expectedProfitUsd: 0.4 },
    { ...base, id: "a", txHash: "0xa", status: "success", priorityFeeGwei: 0.005, expectedProfitUsd: 0.4, gasUsedWei: "4000000000000", gasUsd: 0.0098 },
    { ...base, id: "b", txHash: "0xb", status: "pending", priorityFeeGwei: 0.164, expectedProfitUsd: 1.1 },
    { ...base, id: "b", txHash: "0xb", status: "reverted", priorityFeeGwei: 0.164, expectedProfitUsd: 1.1, gasUsedWei: "20000000000000" },
    { ...base, id: "c", txHash: "0xc", status: "pending", priorityFeeGwei: 0.005, expectedProfitUsd: 0.3 },
  ];
  writeFileSync(join(dir, "live.jsonl"), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const [day] = await summarizeLive(new Store(dir), 2500);
  assert.deepEqual([day.sent, day.landed, day.reverted, day.dropped, day.pending], [3, 1, 1, 0, 1], "one row per transaction, its latest status");
  assert.ok(Math.abs(day.gasUsd - 0.0598) < 1e-9, "gas from gasUsd, or from gasUsedWei for older records");
  assert.equal(day.expectedNetUsd, 0.4, "only landed trades count toward the expected net");
  assert.deepEqual(await summarizeLive(new Store(mkdtempSync(join(tmpdir(), "none-"))), 2500), [], "no file, no rows");
  const s = { mode: "live", minProfitUsd: 0.25, minPoolLiquidityWeth: 1, maxPools: 400, clPools: true, multiHop: true, maxHops: 3, maxCycles: 40, priorityFeeGwei: 0.005, gasRouteBase: 1, gasHopV2: 1, gasHopCl: 1, flashblocks: false, flashblockPollMs: 200, flashblockMaxPools: 40, liquidations: false, liqCheckEvery: 5, liqSwapCostBps: 30, tokenBlacklist: new Set(), refreshMode: "events", fullRefreshBlocks: 300, rpcFallbackUrls: [] };
  const text = renderDigest({ day: day.day, settings: s, pools: { total: 1, cl: 0, pairs: 1 }, paperDays: [], live: { days: [day], safety: { blocked: null, stopFile: true, gasSpentTodayUsd: 0.06, maxDailyGasUsd: 1, consecutiveFailures: 1, limit: 5 } } });
  assert.match(text, /## Live trading/);
  assert.match(text, /Sending \*\*stopped\*\* \(STOP file present\)/);
  assert.match(text, /\| 3 \| 1 \| 1 \| 0 \(\+1 pending\) \| \$0\.060 \| \$0\.400 \|/);
  const none = renderDigest({ day: day.day, settings: s, pools: { total: 1, cl: 0, pairs: 1 }, paperDays: [], live: { days: [] } });
  assert.match(none, /No live transactions sent yet/);
});

test("a hub token isn't blamed for the small tokens paired with it; the one plausible culprit is", () => {
  const HUB = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b";
  const L = new Learner(null, {}, (a) => (a === HUB ? "HUB" : a.slice(0, 6)));
  const t0 = Date.now();
  const via = (partner, sim) => ({
    ...opp(HUB),
    pairSymbols: "WETH>HUB>X>WETH",
    sim,
    simDetail: sim === "executor-revert" ? "Error(transferFrom reverted)" : undefined,
    route: { pools: [pool(), pool(), pool()], tokens: [WETH, HUB, partner, WETH], dexes: ["aerodrome", "uniswap-v2", "uniswap-v3"] },
  });
  // Before the hub has passed anything, a failure through it and a partner is ambiguous: no token is blamed.
  const partners = Array.from({ length: 8 }, () => pool());
  for (const x of partners) L.onSim(via(x, "executor-revert"), t0);
  assert.equal(L.summary(t0).skipping.length, 0);
  assert.equal(L.skipReason(opp(HUB), t0), null, "the hub is still tested");
  // Once the hub passes a test run, its partners' failures are pinned on them, not on it.
  L.onSim(via(GOOD, "executor-ok"), t0);
  const bad = partners[0];
  for (let i = 0; i < 5; i++) L.onSim(via(bad, "executor-revert"), t0);
  const skipping = L.summary(t0).skipping.map((x) => x.token);
  assert.ok(skipping.includes(bad), "the partner that keeps failing is skipped");
  assert.ok(!skipping.includes(HUB), "the hub is not");
  assert.equal(L.skipReason(opp(HUB), t0 + HOUR), null);
  assert.match(L.skipReason(via(bad, "executor-ok"), t0 + HOUR) ?? "", /failed/);
});

test("a memory file built with the older blame rules is re-learned from the data files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relearn-"));
  const now = Date.now();
  writeFileSync(join(dir, "learned.json"), JSON.stringify({ v: 1, since: now, tokens: { [GOOD]: { ok: { v: 0, t: 0 }, fail: { v: 50, t: now } } }, pools: {}, routes: {}, poolSeen: {}, rivalFees: {}, prunedTotal: 0, counts: { sims: 50, outcomes: 0, rivalArbs: 0, liveSends: 0 } }));
  writeFileSync(join(dir, "opportunities.jsonl"), JSON.stringify({ ...opp(GOOD), kind: "opportunity", amountIn: "1", amountMid: "1", amountOut: "2", profit: "1" }) + "\n");
  const L = new Learner(new Store(dir), {}, sym);
  assert.equal(await L.load(), "relearned");
  assert.equal(L.summary().counts.sims, 1);
  assert.equal(L.skipReason(opp(GOOD)), null, "the old blame is gone");
  L.save(true);
  assert.equal(await new Learner(new Store(dir), {}, sym).load(), "loaded");
});

test("tuning: a blocked token can be unblocked, and isn't suggested again for a week", () => {
  const L = new Learner(null, {}, sym);
  for (let i = 0; i < 12; i++) L.onSim(opp(BAD, { sim: "executor-revert", simDetail: "TransferFailed()" }));
  const T = new Tuning(null, { minProfitUsd: 0.25, maxBidShare: 0.3, evMinUsd: 0.01 });
  const block = T.refresh(L, null).find((x) => x.key === "blockToken");
  assert.equal(T.act("apply", block.id).ok, true);
  assert.ok(T.blocked.has(BAD));
  assert.deepEqual(T.act("unblock", "0xBAD0000000000000000000000000000000000001"), { ok: true, unblockedToken: BAD });
  assert.ok(!T.blocked.has(BAD));
  assert.ok(!T.refresh(L, null).some((x) => x.id === `block:${BAD}`), "not suggested again straight away");
  assert.equal(T.act("unblock", BAD).ok, false);
  assert.match(T.view().applied[0].title, /^Unblock /);
});
