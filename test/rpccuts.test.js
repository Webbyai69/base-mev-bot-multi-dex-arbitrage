/**
 * RPC cuts (Oct 2026): fewer eth_calls per block without changing what the bot sees.
 *
 *   1. A Flashblocks pending read no longer forces a re-read at the confirmed block: the pool's
 *      confirmed state is saved before the pending read and put back, then the block's logs apply.
 *   2. Multicall chunks of 600 sub-calls instead of 150 (providers bill per eth_call).
 *   3. Uniswap V4 pools follow the PoolManager's Swap / ModifyLiquidity logs instead of being
 *      re-read from StateView every block.
 *
 * Each test counts the eth_calls the mock chain receives, and checks the state against a fresh read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder } from "ethers";
import { baseScenario } from "./mockchain.mjs";
import { Chain, defaultChainOptions } from "../dist/rpc.js";
import { PoolRegistry } from "../dist/pools.js";
import { BlockLogFetcher } from "../dist/blocklogs.js";
import { TOPIC_SWAP_V3, TOPIC_SWAP_V4, TOPIC_MODIFY_LIQUIDITY_V4, stateViewIface, univ2PairIface } from "../dist/abi.js";
import { V4 } from "../dist/config.js";
import { wordsNeeded, virtualReserves } from "../dist/clmath.js";
import { setLogLevel } from "../dist/log.js";

setLogLevel("error");
const abi = AbiCoder.defaultAbiCoder();
const E18 = 10n ** 18n, E6 = 10n ** 6n;
const Q96 = 2n ** 96n;
const pad = (x) => "0x" + x.toLowerCase().replace("0x", "").padStart(64, "0");
const ethCalls = (sc, since) => sc.c.requests.slice(since).filter((m) => m === "eth_call").length;

/** A synced registry over the mock chain's V2/Aerodrome pools. */
async function synced(t) {
  const sc = baseScenario();
  await sc.c.listen();
  t.after(() => sc.c.close().catch(() => undefined));
  sc.c.activityBlock();
  const c = new Chain(sc.c.url);
  t.after(() => c.destroy().catch(() => undefined));
  const r = new PoolRegistry(c);
  await r.discover({ minLiquidityWeth: 2, maxPools: 400, mode: "activity", lookbackBlocks: 5, logRange: 2 });
  const n = await c.blockNumber();
  await r.refreshAll(n);
  return { sc, c, r, n };
}

/** A concentrated-liquidity pool object with the bitmap words for its tick already read. */
function clPool(address, token0, token1, { tick = 0, liquidity = 10n ** 20n, v4 } = {}) {
  const tickSpacing = 60;
  const words = new Map(wordsNeeded(tick, tickSpacing).map((w) => [w, 0n]));
  const cl = { sqrtPriceX96: Q96, tick, liquidity, tickSpacing, feePips: 500, words, quoter: "0x0000000000000000000000000000000000000001" };
  const p = {
    address, dex: v4 ? "uniswap-v4" : "uniswap-v3", kind: v4 ? "univ4" : "univ3", token0, token1,
    reserve0: 0n, reserve1: 0n, feePpm: 500, feeModel: "ppm", stable: false, updatedBlock: 0, cl,
    ...(v4 ? { v4: { poolId: address, currency0: token0, currency1: token1, fee: 500, tickSpacing, hooks: "0x0000000000000000000000000000000000000000" } } : {}),
  };
  const v = virtualReserves(cl);
  p.reserve0 = v.reserve0;
  p.reserve1 = v.reserve1;
  return p;
}

const logMeta = (n) => ({ blockNumber: n, blockHash: "0x" + "ab".repeat(32), transactionHash: "0x" + "cd".repeat(32), transactionIndex: 0, index: 0, removed: false });

// ---------------------------------------------------------------- 1. pending reads

test("cut 1: pending reads are undone at the confirmed block with no re-read, landed or not", async (t) => {
  const { sc, c, r } = await synced(t);
  const X = sc.uniWethUsdc.address, Y = sc.aeroWethUsdc.address;
  const mx = sc.c.pools.get(X), my = sc.c.pools.get(Y);
  const yBefore = [my.reserve0, my.reserve1];

  // Pre-confirmed state: a swap is in progress on X and on Y.
  mx.reserve0 += E18; mx.reserve1 -= 2000n * E6;
  my.reserve0 += E18 / 2n; my.reserve1 -= 1000n * E6;
  await r.refreshReserves([r.pools.get(X), r.pools.get(Y)], "pending");
  assert.equal(r.pools.get(X).reserve0, mx.reserve0, "pending state visible to the Flashblocks scan");
  assert.equal(r.pools.get(Y).reserve0, my.reserve0);

  // A second pending read must not replace the saved confirmed state with the first pending one.
  await r.refreshReserves([r.pools.get(Y)], "pending");

  // The block confirms: X's swap landed (Sync in the block), Y's didn't (state back to before).
  [my.reserve0, my.reserve1] = yBefore;
  sc.c.queuedLogs.push(sc.c.syncLog(mx));
  const n = sc.c.nextBlock();
  const logs = await new BlockLogFetcher(c, { liquidations: false }).fetch(r.syncedBlock + 1, n);
  const mark = sc.c.requests.length;
  await r.applyLogs(logs, n);
  assert.equal(ethCalls(sc, mark), 0, "no eth_call: the confirmed state came back from memory and the logs");

  assert.equal(r.pools.get(X).reserve0, mx.reserve0, "landed swap applied from its Sync log");
  assert.equal(r.pools.get(X).reserve1, mx.reserve1);
  assert.equal(r.pools.get(Y).reserve0, yBefore[0], "dropped pending swap undone");
  assert.equal(r.pools.get(Y).reserve1, yBefore[1]);

  // And a full re-read at the same block agrees everywhere (what the periodic drift check does).
  const snap = r.stateSnapshot();
  await r.refreshAll(n);
  assert.deepEqual(r.driftAgainst(snap), []);
});

test("cut 1: a CL pool's confirmed state (price, tick, liquidity, words) is restored, then its Swap applies", async (t) => {
  const { sc, c, r, n } = await synced(t);
  const A = "0xcccc000000000000000000000000000000000001";
  const p = clPool(A, sc.WETH.toLowerCase(), sc.USDC.toLowerCase(), { tick: 120 });
  r.pools.set(A, p);
  const words = p.cl.words;

  // The pending read reaches a pool the mock can't answer: it marks the pool unusable (liquidity 0).
  await r.refreshReserves([p], "pending");
  assert.equal(p.cl.liquidity, 0n, "pending read changed the pool");

  // Confirmed block: a V3 Swap on the pool, to a tick in the same bitmap words.
  const swap = { address: A, topics: [TOPIC_SWAP_V3, pad(A), pad(A)], data: abi.encode(["int256", "int256", "uint160", "uint128", "int24"], [1n, -1n, (Q96 * 1001n) / 1000n, 7n * 10n ** 19n, 150]), ...logMeta(n + 1) };
  sc.c.nextBlock();
  const mark = sc.c.requests.length;
  await r.applyLogs([swap], n + 1);
  assert.equal(ethCalls(sc, mark), 0, "no re-read of the pool");
  assert.equal(p.cl.liquidity, 7n * 10n ** 19n, "Swap applied on top of the restored state");
  assert.equal(p.cl.tick, 150);
  assert.equal(p.cl.words, words, "bitmap words restored");
  assert.deepEqual([p.reserve0, p.reserve1], Object.values(virtualReserves(p.cl)), "virtual reserves recomputed");
});

test("cut 1: refreshAll also undoes pending reads first", async (t) => {
  const { sc, r, n } = await synced(t);
  const X = sc.uniWethUsdc.address;
  const mx = sc.c.pools.get(X);
  const before = mx.reserve0;
  mx.reserve0 += E18;
  await r.refreshReserves([r.pools.get(X)], "pending");
  mx.reserve0 = before;
  await r.refreshAll(n);
  assert.equal(r.pools.get(X).reserve0, before);
  // Nothing left over to restore at the next block.
  mx.reserve0 += 5n;
  sc.c.queuedLogs.push(sc.c.syncLog(mx));
  const n2 = sc.c.nextBlock();
  const logs = await new BlockLogFetcher(r.chain, { liquidations: false }).fetch(n + 1, n2);
  await r.applyLogs(logs, n2);
  assert.equal(r.pools.get(X).reserve0, mx.reserve0);
});

// ---------------------------------------------------------------- 2. chunk size

test("cut 2: 600 sub-calls per multicall on Alchemy and other providers, 120 on the public endpoint", async (t) => {
  assert.equal(defaultChainOptions("https://base-mainnet.g.alchemy.com/v2/k").chunkSize, 600);
  assert.equal(defaultChainOptions("https://lb.drpc.live/base/k").chunkSize, 600);
  assert.equal(defaultChainOptions("https://mainnet.base.org").chunkSize, 120);

  const sc = baseScenario();
  await sc.c.listen();
  t.after(() => sc.c.close().catch(() => undefined));
  const data = univ2PairIface.encodeFunctionData("getReserves");
  const calls = Array.from({ length: 1300 }, () => ({ target: sc.uniWethUsdc.address, callData: data }));
  for (const [chunkSize, expected] of [[150, 9], [600, 3]]) {
    const c = new Chain(sc.c.url, undefined, { chunkSize, batchMaxCount: 1 });
    const mark = sc.c.requests.length;
    const res = await c.multicall(calls);
    await c.destroy();
    assert.equal(ethCalls(sc, mark), expected, `${chunkSize} per call`);
    assert.ok(res.every((x) => x.success), "every sub-call answered, in order");
  }
});

// ---------------------------------------------------------------- 3. Uniswap V4 from logs

/** A mock StateView (V4 has no pool contracts) serving one pool's state. */
function mockStateView(sc, state) {
  const reads = [];
  sc.c.contracts.set(V4.stateView.toLowerCase(), (data) => {
    const f = stateViewIface.parseTransaction({ data });
    reads.push(f.name);
    if (f.name === "getSlot0") return stateViewIface.encodeFunctionResult("getSlot0", [state.sqrtPriceX96, state.tick, 0, 500]);
    if (f.name === "getLiquidity") return stateViewIface.encodeFunctionResult("getLiquidity", [state.liquidity]);
    return stateViewIface.encodeFunctionResult("getTickBitmap", [0n]);
  });
  return reads;
}

test("cut 3: a V4 Swap updates the pool from the log alone; ModifyLiquidity re-reads it from StateView", async (t) => {
  const { sc, r, n } = await synced(t);
  const id = "0x" + "4b".repeat(32);
  const p = clPool(id, sc.WETH.toLowerCase(), sc.USDC.toLowerCase(), { tick: 60, v4: true });
  r.pools.set(id, p);
  const state = { sqrtPriceX96: (Q96 * 999n) / 1000n, tick: 30, liquidity: 5n * 10n ** 19n };
  const reads = mockStateView(sc, state);
  const pm = V4.poolManager;

  // Swap (amount0, amount1, sqrtPriceX96, liquidity, tick, fee), a tick that stays in the read words.
  const swap = { address: pm, topics: [TOPIC_SWAP_V4, id, pad("0x" + "11".repeat(20))], data: abi.encode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], [5n, -5n, (Q96 * 1002n) / 1000n, 8n * 10n ** 19n, 90, 500]), ...logMeta(n + 1) };
  // Another V4 pool's Swap (not watched) must be ignored.
  const other = { ...swap, topics: [TOPIC_SWAP_V4, "0x" + "99".repeat(32), swap.topics[2]] };
  sc.c.nextBlock();
  let mark = sc.c.requests.length;
  const before = p.reserve0;
  await r.applyLogs([other, swap], n + 1);
  assert.equal(ethCalls(sc, mark), 0, "no StateView read for a swap");
  assert.equal(p.cl.liquidity, 8n * 10n ** 19n);
  assert.equal(p.cl.tick, 90);
  assert.equal(p.cl.sqrtPriceX96, (Q96 * 1002n) / 1000n);
  assert.notEqual(p.reserve0, before, "virtual reserves recomputed");
  assert.equal(p.updatedBlock, n + 1);

  // ModifyLiquidity changes liquidity and the bitmap, which the log can't tell us: one StateView read.
  const mod = { address: pm, topics: [TOPIC_MODIFY_LIQUIDITY_V4, id, pad("0x" + "11".repeat(20))], data: abi.encode(["int24", "int24", "int256", "bytes32"], [-600, 600, 10n ** 18n, "0x" + "00".repeat(32)]), ...logMeta(n + 2) };
  sc.c.nextBlock();
  mark = sc.c.requests.length;
  reads.length = 0;
  await r.applyLogs([mod], n + 2);
  assert.equal(ethCalls(sc, mark), 1, "one multicall");
  assert.ok(reads.includes("getSlot0") && reads.includes("getLiquidity") && reads.includes("getTickBitmap"));
  assert.equal(p.cl.liquidity, state.liquidity, "state now from StateView");
  assert.equal(p.cl.tick, state.tick);
});

test("cut 3: no V4 read in a block without V4 logs; refreshAll still covers V4 for the drift check", async (t) => {
  const { sc, r, n } = await synced(t);
  const id = "0x" + "4c".repeat(32);
  r.pools.set(id, clPool(id, sc.WETH.toLowerCase(), sc.USDC.toLowerCase(), { tick: 60, v4: true }));
  const state = { sqrtPriceX96: Q96, tick: 0, liquidity: 3n * 10n ** 19n };
  const reads = mockStateView(sc, state);
  sc.c.nextBlock();
  await r.applyLogs([], n + 1);
  assert.equal(reads.length, 0, "a quiet V4 pool costs nothing");
  await r.refreshAll(n + 1);
  assert.ok(reads.includes("getSlot0"), "the periodic full re-read includes V4 pools");
  assert.equal(r.pools.get(id).cl.liquidity, state.liquidity);
});

test("cut 3: the shared per-block eth_getLogs asks for the V4 PoolManager's events", async () => {
  const c = new Chain("http://127.0.0.1:1");
  const f = new BlockLogFetcher(c, { liquidations: false });
  assert.ok(f.topics.includes(TOPIC_SWAP_V4) && f.topics.includes(TOPIC_MODIFY_LIQUIDITY_V4));
  await c.destroy();
});

test("cut 3: the incremental scan re-scores a V4 pool only when its own PoolManager event is in the block", async (t) => {
  const { sc, r, n } = await synced(t);
  const a = "0x" + "4d".repeat(32), b = "0x" + "4e".repeat(32);
  const usdc = sc.USDC.toLowerCase(), weth = sc.WETH.toLowerCase();
  r.pools.set(a, clPool(a, weth, usdc, { v4: true }));
  r.pools.set(b, clPool(b, weth, usdc, { v4: true }));
  const v2 = [...r.pools.values()].find((p) => !p.cl);
  const swapOf = (id) => ({ address: V4.poolManager, topics: [TOPIC_SWAP_V4, id, pad("0x" + "11".repeat(20))], data: "0x", ...logMeta(n + 1) });
  assert.deepEqual([...r.touchedBy([])], [], "a quiet block touches no V4 pool");
  assert.deepEqual([...r.touchedBy([swapOf(a), swapOf("0x" + "99".repeat(32))])], [a], "keyed by poolId; unwatched ids ignored");
  assert.deepEqual([...r.touchedBy([{ address: v2.address.toUpperCase().replace("0X", "0x"), topics: [], data: "0x", ...logMeta(n + 1) }])], [v2.address]);
});
