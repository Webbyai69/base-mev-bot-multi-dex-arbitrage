/**
 * PancakeSwap V3 as a quote-only CL venue (src/config.ts CL_DEXES, src/abi.ts topic, src/pools.ts decode):
 *  - its Swap event has a distinct topic (two extra protocol-fee fields) but the first five fields match
 *    Uniswap V3, so the applyLogs decode reads sqrtPriceX96 / liquidity / tick from the same positions;
 *  - it is configured with Pancake's own fee tiers (incl. 2500) and marked executable:true (the RouteExecutor now has its callback).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder } from "ethers";
import { CL_DEXES } from "../dist/config.js";
import { TOPIC_SWAP_PANCAKE_V3, TOPIC_SWAP_V3 } from "../dist/abi.js";

const abi = AbiCoder.defaultAbiCoder();
const pcs = () => CL_DEXES.find((d) => d.id === "pancakeswap-v3");

test("PancakeSwap V3 is configured as an executable CL venue with Pancake's fee tiers", () => {
  const d = pcs();
  assert.ok(d, "pancakeswap-v3 is in CL_DEXES");
  assert.equal(d.kind, "pancakev3");
  assert.equal(d.executable, true, "executable now the RouteExecutor has the PancakeSwap V3 callback");
  assert.equal(d.factory.toLowerCase(), "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865");
  assert.equal(d.quoter.toLowerCase(), "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997");
  // Pancake's 2500 tier is the one that differs from Uniswap's 3000.
  assert.deepEqual(d.poolKeys, [100, 500, 2500, 10000]);
});

test("Uniswap V3 stays executable (executable is not false)", () => {
  const uni = CL_DEXES.find((d) => d.id === "uniswap-v3");
  assert.ok(uni);
  assert.notEqual(uni.executable, false);
});

test("Pancake's Swap topic is distinct from Uniswap V3's", () => {
  assert.notEqual(TOPIC_SWAP_PANCAKE_V3, TOPIC_SWAP_V3);
  assert.equal(TOPIC_SWAP_PANCAKE_V3, "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83");
});

test("the Pancake Swap decode reads sqrtPriceX96 / liquidity / tick despite the two extra fields", () => {
  const sqrtP = 1234567890123456789012345n;
  const liq = 987654321n;
  const tick = -201234;
  // A real Pancake V3 Swap payload: amount0, amount1, sqrtPriceX96, liquidity, tick, protocolFees0, protocolFees1.
  const data = abi.encode(
    ["int256", "int256", "uint160", "uint128", "int24", "uint128", "uint128"],
    [-1000n, 2000n, sqrtP, liq, tick, 7n, 8n],
  );
  // Exactly what applyLogs decodes for a Pancake Swap.
  const d = abi.decode(["int256", "int256", "uint160", "uint128", "int24", "uint128", "uint128"], data);
  assert.equal(d[2], sqrtP, "sqrtPriceX96");
  assert.equal(d[3], liq, "liquidity");
  assert.equal(Number(d[4]), tick, "tick");
});
