/**
 * Flashblocks: decoding the websocket stream, and the watcher re-scoring on every Flashblock
 * from pending copies of the pools (never touching the confirmed state).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { AbiCoder } from "ethers";
import { parseFlashblock, FlashblockWatcher, FlashblockStream } from "../dist/flashblocks.js";
import { PoolRegistry } from "../dist/pools.js";
import { TOPIC_SYNC, TOPIC_MINT_V3, TOPIC_SWAP_V3 } from "../dist/abi.js";
import { setLogLevel } from "../dist/log.js";

setLogLevel("error");
const abi = AbiCoder.defaultAbiCoder();
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const POOL_A = "0x00000000000000000000000000000000000000a1";
const POOL_B = "0x00000000000000000000000000000000000000b2";
const POOL_CL = "0x00000000000000000000000000000000000000c3";

const sync = (pool, r0, r1) => ({ address: pool, topics: [TOPIC_SYNC], data: abi.encode(["uint112", "uint112"], [r0, r1]) });

/** A message as Base's stream sends it (receipts keyed by tx hash, wrapped in their type). */
function message(block, index, logs, { status = "0x1", hexBase = false } = {}) {
  return {
    payload_id: "0x03997352d799c31a",
    index,
    ...(index === 0 ? { base: { block_number: "0x" + block.toString(16), parent_hash: "0x" + "00".repeat(32) } } : {}),
    diff: { state_root: "0x" + "11".repeat(32), transactions: [], withdrawals: [] },
    metadata: {
      ...(hexBase ? {} : { block_number: block }),
      new_account_balances: {},
      receipts: { ["0x" + "ab".repeat(32)]: { Eip1559: { status, cumulativeGasUsed: "0x5208", logs } } },
    },
  };
}

test("parses plain JSON and brotli-compressed binary frames, with type-wrapped receipts", () => {
  const msg = message(30_000_001, 3, [sync(POOL_A, 5n, 7n)]);
  const a = parseFlashblock(JSON.stringify(msg));
  assert.equal(a.block, 30_000_001);
  assert.equal(a.index, 3);
  assert.equal(a.logs.length, 1);
  assert.equal(a.logs[0].address, POOL_A);
  assert.equal(a.logs[0].topics[0], TOPIC_SYNC);
  const b = parseFlashblock(brotliCompressSync(Buffer.from(JSON.stringify(msg))));
  assert.deepEqual(b, a);
  // Plain JSON in a binary frame works too.
  assert.deepEqual(parseFlashblock(Buffer.from(JSON.stringify(msg))), a);
});

test("reads the block number from base on index 0, skips reverted transactions, accepts unwrapped receipts", () => {
  const first = parseFlashblock(JSON.stringify(message(77, 0, [sync(POOL_A, 1n, 2n)], { hexBase: true })));
  assert.equal(first.block, 77);
  const reverted = parseFlashblock(JSON.stringify(message(77, 1, [sync(POOL_A, 1n, 2n)], { status: "0x0" })));
  assert.equal(reverted.logs.length, 0, "a reverted transaction changed nothing");
  const unwrapped = { index: 2, metadata: { block_number: "0x4d", receipts: [{ status: "0x1", logs: [sync(POOL_B, 3n, 4n)] }] } };
  const u = parseFlashblock(JSON.stringify(unwrapped));
  assert.equal(u.block, 77);
  assert.equal(u.logs[0].address, POOL_B);
  assert.equal(parseFlashblock(JSON.stringify({ hello: "world" })), null, "not a flashblock");
});

function registry() {
  const r = new PoolRegistry(null);
  const v2 = (address, r0, r1) => ({ address, dex: "uniswap-v2", kind: "univ2", token0: WETH, token1: USDC, reserve0: r0, reserve1: r1, feePpm: 3000, feeModel: "ppm", stable: false, updatedBlock: 1 });
  r.pools.set(POOL_A, v2(POOL_A, 100n * E18, 300_000n * E6));
  r.pools.set(POOL_B, v2(POOL_B, 100n * E18, 300_000n * E6));
  r.pools.set(POOL_CL, {
    address: POOL_CL, dex: "uniswap-v3", kind: "univ3", token0: WETH, token1: USDC, reserve0: 1n, reserve1: 1n, feePpm: 500, feeModel: "ppm", stable: false, updatedBlock: 1,
    cl: { sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 10n ** 18n, tickSpacing: 10, feePips: 500, words: new Map([[-1, 0n], [0, 0n]]), quoter: "0x" + "00".repeat(20) },
  });
  return r;
}

/** Records what the watcher asks the scanner to do; finds nothing. */
function fakeScanner() {
  const calls = [];
  return {
    calls,
    async scan(block, gas, ethUsd, min, opts) {
      calls.push({ block, opts, a: opts.overlay.get(POOL_A) ? { ...opts.overlay.get(POOL_A) } : null });
      return [];
    },
  };
}
const ctx = (block) => ({ block, seenAt: Date.now(), gas: { totalWei: 0n, baseFeeWei: 0n, priorityFeeWei: 0n, l1FeeWei: 0n }, ethUsd: 3000 });

test("every Flashblock that changes a watched pool is re-scored from a pending copy; the confirmed pool is untouched", async () => {
  const reg = registry();
  const scanner = fakeScanner();
  const paper = { register() {} };
  const w = new FlashblockWatcher(null, reg, scanner, paper, { pollMs: 200, maxPools: 10, minProfitUsd: 0.25 });
  w.onConfirmedBlock(ctx(100), []);
  for (let i = 0; i < 10; i++) {
    w.onFlashblock({ block: 101, index: i, logs: [sync(POOL_A, 100n * E18 + BigInt(i) * E18, 300_000n * E6)] });
    await w.idle;
  }
  assert.equal(scanner.calls.length, 10, "one re-score per Flashblock");
  const last = scanner.calls[9];
  assert.equal(last.opts.stage, "flashblock");
  assert.equal(last.opts.blockTag, "pending");
  assert.deepEqual([...last.opts.changed], [POOL_A], "only routes through the changed pool");
  assert.equal(last.a.reserve0, 109n * E18, "pending state from the log");
  assert.equal(reg.pools.get(POOL_A).reserve0, 100n * E18, "confirmed state untouched");
  const st = w.stats;
  assert.equal(st.flashblocks, 10);
  assert.equal(st.scans, 10);
  assert.equal(st.scansPerMin, 10);
  assert.equal(st.overlayPools, 1);
});

test("Flashblocks for an already-confirmed block, or touching no watched pool, cost nothing", async () => {
  const reg = registry();
  const scanner = fakeScanner();
  const w = new FlashblockWatcher(null, reg, scanner, { register() {} }, { pollMs: 200, maxPools: 10, minProfitUsd: 0.25 });
  w.onFlashblock({ block: 101, index: 0, logs: [sync(POOL_A, 1n, 2n)] }); // nothing confirmed yet
  w.onConfirmedBlock(ctx(101), []);
  w.onFlashblock({ block: 101, index: 5, logs: [sync(POOL_A, 1n, 2n)] }); // stale
  w.onFlashblock({ block: 102, index: 0, logs: [sync("0x00000000000000000000000000000000000000ff", 1n, 2n)] }); // not watched
  await w.idle;
  assert.equal(scanner.calls.length, 0);
  assert.equal(w.stats.stale, 1);
  assert.equal(w.stats.flashblocks, 3);
});

test("pending copies are dropped once their block is confirmed; a liquidity change sits out until then", async () => {
  const reg = registry();
  const scanner = fakeScanner();
  const w = new FlashblockWatcher(null, reg, scanner, { register() {} }, { pollMs: 200, maxPools: 10, minProfitUsd: 0.25 });
  w.onConfirmedBlock(ctx(200), []);
  const mint = { address: POOL_CL, topics: [TOPIC_MINT_V3, "0x" + "00".repeat(32), "0x" + "00".repeat(32), "0x" + "00".repeat(32)], data: "0x" };
  w.onFlashblock({ block: 201, index: 1, logs: [sync(POOL_B, 90n * E18, 310_000n * E6), mint] });
  await w.idle;
  const call = scanner.calls[0];
  assert.ok(call.opts.exclude.has(POOL_CL), "the CL pool's liquidity is unknown until the next block");
  assert.deepEqual([...call.opts.changed].sort(), [POOL_B, POOL_CL].sort());
  assert.equal(w.stats.overlayPools, 2);
  assert.equal(w.stats.unsettledPools, 1);
  // A V3 swap on a settled pool updates price, tick and liquidity exactly.
  const swap = { address: POOL_CL, topics: [TOPIC_SWAP_V3, "0x" + "00".repeat(32), "0x" + "00".repeat(32)], data: abi.encode(["int256", "int256", "uint160", "uint128", "int24"], [1n, -1n, (1n << 96n) + 1000n, 5n * 10n ** 17n, 0]) };
  w.onConfirmedBlock(ctx(201), []);
  assert.equal(w.stats.overlayPools, 0, "block 201 confirmed: its pending copies are gone");
  assert.equal(w.stats.unsettledPools, 0);
  w.onFlashblock({ block: 202, index: 0, logs: [swap] });
  await w.idle;
  assert.equal(scanner.calls[1].opts.exclude.size, 0);
  assert.equal(scanner.calls.length, 2);
});

test("re-scores never pile up: Flashblocks arriving during a re-score are merged into the next one", async () => {
  const reg = registry();
  let release;
  const calls = [];
  const scanner = {
    async scan(block, gas, ethUsd, min, opts) {
      calls.push([...opts.changed].sort());
      if (calls.length === 1) await new Promise((r) => (release = r));
      return [];
    },
  };
  const w = new FlashblockWatcher(null, reg, scanner, { register() {} }, { pollMs: 200, maxPools: 10, minProfitUsd: 0.25 });
  w.onConfirmedBlock(ctx(300), []);
  w.onFlashblock({ block: 301, index: 0, logs: [sync(POOL_A, 1n * E18, 3000n * E6)] });
  w.onFlashblock({ block: 301, index: 1, logs: [sync(POOL_B, 2n * E18, 3000n * E6)] });
  w.onFlashblock({ block: 301, index: 2, logs: [sync(POOL_A, 3n * E18, 3000n * E6)] });
  release();
  await new Promise((r) => setTimeout(r, 10));
  await w.idle;
  assert.deepEqual(calls, [[POOL_A], [POOL_A, POOL_B].sort()]);
});

test("the stream delivers decoded Flashblocks and reconnects after a drop", async () => {
  const sockets = [];
  const factory = () => {
    const ws = new EventEmitter();
    ws.terminate = () => ws.emit("close");
    sockets.push(ws);
    return ws;
  };
  const got = [];
  const s = new FlashblockStream("wss://example.invalid/ws", (fb) => got.push(fb), factory, 60_000);
  s.start();
  sockets[0].emit("open");
  sockets[0].emit("message", brotliCompressSync(Buffer.from(JSON.stringify(message(5, 0, [sync(POOL_A, 1n, 2n)])))));
  sockets[0].emit("message", Buffer.from("not json"));
  assert.equal(got.length, 1);
  assert.equal(got[0].block, 5);
  assert.equal(s.stats.parseErrors, 1);
  assert.ok(s.live);
  sockets[0].emit("close");
  assert.equal(s.stats.connected, 0);
  assert.equal(s.stats.reconnects, 1);
  s.stop();
});
