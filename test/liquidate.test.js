/**
 * The liquidation swap planner (src/liquidate.ts): finding a path to swap the
 * seized collateral back to the debt asset — a direct pool when one exists,
 * else through WETH or USDC, else null (skip).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSwap } from "../dist/liquidate.js";
import { pairKey } from "../dist/pools.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CBETH = "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22";
const DEGEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";
let n = 0;
const pool = () => "0x" + (++n).toString(16).padStart(40, "e");

function mkPool(t0, t1, over = {}) {
  return { address: pool(), dex: "uniswap-v2", kind: "univ2", token0: t0.toLowerCase(), token1: t1.toLowerCase(), reserve0: 10n ** 21n, reserve1: 10n ** 21n, feePpm: 3000, feeModel: "ppm", stable: false, updatedBlock: 1, ...over };
}

/** A minimal registry: planSwap only uses groups(). */
function registry(pools) {
  const groups = new Map();
  for (const p of pools) {
    const k = pairKey(p.token0, p.token1);
    (groups.get(k) ?? groups.set(k, []).get(k)).push(p);
  }
  return { groups: () => groups };
}

test("a direct collateral/debt pool is used when it exists", () => {
  const direct = mkPool(CBETH, USDC);
  const plan = planSwap(registry([direct, mkPool(WETH, USDC)]), CBETH, USDC);
  assert.deepEqual(plan.tokens, [CBETH.toLowerCase(), USDC.toLowerCase()]);
  assert.equal(plan.hops.length, 1);
  assert.equal(plan.hops[0].pool, direct.address);
  assert.equal(plan.hops[0].kind, 0); // V2 ppm
});

test("the deepest direct pool is chosen", () => {
  const shallow = mkPool(CBETH, USDC, { reserve0: 10n ** 18n, reserve1: 10n ** 18n });
  const deep = mkPool(CBETH, USDC, { reserve0: 10n ** 24n, reserve1: 10n ** 24n });
  const plan = planSwap(registry([shallow, deep]), CBETH, USDC);
  assert.equal(plan.hops[0].pool, deep.address);
});

test("no direct pool: route through WETH", () => {
  const a = mkPool(DEGEN, WETH);
  const b = mkPool(WETH, USDC);
  const plan = planSwap(registry([a, b]), DEGEN, USDC);
  assert.deepEqual(plan.tokens, [DEGEN.toLowerCase(), WETH, USDC]);
  assert.deepEqual(plan.hops.map((h) => h.pool), [a.address, b.address]);
});

test("a CL pool is tagged kind 2", () => {
  const cl = mkPool(CBETH, USDC, { dex: "uniswap-v3", kind: "univ3", cl: { sqrtPriceX96: 1n, tick: 0, liquidity: 1n, tickSpacing: 60, feePips: 500, words: new Map(), quoter: pool() }, feePpm: 500 });
  const plan = planSwap(registry([cl]), CBETH, USDC);
  assert.equal(plan.hops[0].kind, 2);
});

test("no route at all returns null", () => {
  assert.equal(planSwap(registry([mkPool(WETH, USDC)]), DEGEN, CBETH), null);
  // Same asset for debt and collateral is never planned.
  assert.equal(planSwap(registry([mkPool(CBETH, USDC)]), CBETH, CBETH), null);
});
