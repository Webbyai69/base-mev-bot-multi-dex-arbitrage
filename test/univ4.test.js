/**
 * Uniswap V4 hookless detection (src/abi.ts v4PoolId / ifaces, src/config.ts V4):
 *  - the poolId derivation (keccak256(abi.encode(PoolKey))) must match pools that actually exist on Base,
 *    so these assert against two pools verified live via StateView.getSlot0;
 *  - the StateView / V4Quoter interfaces encode the selectors the real contracts expect;
 *  - the config points at the verified Base contracts and hookless fee tiers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { v4PoolId, v4QuoterIface, stateViewIface } from "../dist/abi.js";
import { V4, NATIVE } from "../dist/config.js";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WETH = "0x4200000000000000000000000000000000000006";

test("v4PoolId matches the ETH/USDC and WETH/USDC V4 pools verified on Base", () => {
  // currency0 sorts first: native ETH (0x0) < USDC, and WETH < USDC. hooks = 0x0 (hookless).
  assert.equal(v4PoolId(NATIVE, USDC, 500, 10, NATIVE), "0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a");
  assert.equal(v4PoolId(WETH, USDC, 3000, 60, NATIVE), "0x1d8c55f347727c0fb4f5e1b65cdb93639e0c7102580a7d345e1144cd5a718f54");
});

test("the V4Quoter and StateView interfaces encode the real selectors", () => {
  const q = v4QuoterIface.encodeFunctionData("quoteExactInputSingle", [
    { poolKey: { currency0: NATIVE, currency1: USDC, fee: 500, tickSpacing: 10, hooks: NATIVE }, zeroForOne: true, exactAmount: 1000000000000000n, hookData: "0x" },
  ]);
  assert.equal(q.slice(0, 10), "0xaa9d21cb", "V4Quoter.quoteExactInputSingle selector");
  const z = "0x" + "00".repeat(32);
  assert.equal(stateViewIface.encodeFunctionData("getSlot0", [z]).slice(0, 10), "0xc815641c");
  assert.equal(stateViewIface.encodeFunctionData("getLiquidity", [z]).slice(0, 10), "0xfa6793d5");
});

test("V4 config points at the verified Base contracts and the hookless tiers", () => {
  assert.equal(V4.poolManager, "0x498581fF718922c3f8e6A244956aF099B2652b2b");
  assert.equal(V4.stateView, "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71");
  assert.equal(V4.quoter, "0x0d5e0F971ED27FBfF6c2837bf31316121532048D");
  const fees = V4.feeTiers.map(([f]) => f);
  for (const f of [100, 500, 3000, 10000]) assert.ok(fees.includes(f), `fee tier ${f}`);
});
