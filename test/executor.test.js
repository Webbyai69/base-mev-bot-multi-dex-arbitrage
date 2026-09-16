/**
 * EVM-level test of contracts/ArbExecutor.sol against mock V2/Aerodrome-style
 * pairs, run inside an in-process EVM (no node, no network).
 *
 * Needs a solc compiler and the ethereumjs VM. Set SOLC_NODE_MODULES to a
 * node_modules directory containing `solc` and `@nomicfoundation/ethereumjs-vm`
 * (e.g. any Hardhat project's node_modules). The test is skipped otherwise.
 *
 * The compiler found there may be < 0.8, so the executor is compiled from an
 * automatically down-converted copy (custom errors -> revert strings); the
 * logic is byte-for-byte the same source otherwise.
 */
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Interface, AbiCoder } from "ethers";
import { quoteArb } from "../dist/math.js";
import { executorIface } from "../dist/abi.js";
import { SIM_EXECUTOR_RUNTIME } from "../dist/simBytecode.js";

const require = createRequire(import.meta.url);
const NM = process.env.SOLC_NODE_MODULES;
let solc, VM, Address;
try {
  solc = require(`${NM}/solc`);
  ({ VM } = require(`${NM}/@nomicfoundation/ethereumjs-vm`));
  ({ Address } = require(`${NM}/@nomicfoundation/ethereumjs-util`));
} catch {
  /* skipped below */
}
// The ethereumjs fork bundled with Hardhat 2.x uses Buffers; newer releases use Uint8Array. Both accept Buffer.
const hexToBytes = (h) => Buffer.from(h.replace(/^0x/, ""), "hex");
const bytesToHex = (b) => "0x" + Buffer.from(b).toString("hex");

const abi = AbiCoder.defaultAbiCoder();
const root = fileURLToPath(new URL("..", import.meta.url));

function downconvert(src) {
  return src
    .replace("pragma solidity ^0.8.20;", "pragma solidity ^0.7.3;")
    .replace(/\n {4}error [A-Za-z]+\([^)]*\);/g, "")
    .replace("if (msg.sender != owner) revert NotOwner();", 'require(msg.sender == owner, "NotOwner");')
    .replace(/if \(profit < minProfit\) revert InsufficientProfit\(profit, minProfit\);/g, 'require(profit >= minProfit, "InsufficientProfit");')
    .replace("revert Simulated(profit);", "assembly { mstore(0x0, profit) revert(0x0, 32) }")
    .replace(/if \(after_ <= before\) revert InsufficientProfit\(0, 1\);/g, 'require(after_ > before, "InsufficientProfit");')
    .replace("if (msg.sender != expectedCaller || sender != address(this)) revert BadCallback();", 'require(msg.sender == expectedCaller && sender == address(this), "BadCallback");')
    .replace("if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();", 'require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "TransferFailed");')
    .replace("if (msg.data.length < 4 + 32 * 4) revert BadCallback();", 'require(msg.data.length >= 4 + 32 * 4, "BadCallback");')
    .replace("if (!ok) revert TransferFailed();", 'require(ok, "TransferFailed");');
}

function compile() {
  const executorSrc = downconvert(readFileSync(`${root}contracts/ArbExecutor.sol`, "utf8"));
  const mocksSrc = readFileSync(`${root}test/contracts/Mocks.sol`, "utf8");
  const input = {
    language: "Solidity",
    sources: { "ArbExecutor.sol": { content: executorSrc }, "Mocks.sol": { content: mocksSrc } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const get = (file, name) => ({ abi: out.contracts[file][name].abi, bytecode: "0x" + out.contracts[file][name].evm.bytecode.object });
  return { executor: get("ArbExecutor.sol", "ArbExecutor"), erc20: get("Mocks.sol", "MockERC20"), pair: get("Mocks.sol", "MockPair") };
}

class Evm {
  constructor(vm) {
    this.vm = vm;
    this.owner = new Address(hexToBytes("0x" + "11".repeat(20)));
    this.stranger = new Address(hexToBytes("0x" + "22".repeat(20)));
  }
  static async create() {
    return new Evm(await VM.create());
  }
  async deploy(artifact, args = [], types = []) {
    const data = artifact.bytecode + (args.length ? abi.encode(types, args).slice(2) : "");
    const r = await this.vm.evm.runCall({ caller: this.owner, data: hexToBytes(data), gasLimit: 30_000_000n });
    if (r.execResult.exceptionError) throw new Error("deploy failed: " + r.execResult.exceptionError.error);
    return { address: r.createdAddress.toString(), iface: new Interface(artifact.abi) };
  }
  /** Emulates an eth_call state override: put runtime code at an address that has none. */
  async injectCode(address, runtimeHex) {
    await this.vm.stateManager.putContractCode(new Address(hexToBytes(address)), hexToBytes(runtimeHex));
  }
  async call(contract, fn, args = [], { from = this.owner } = {}) {
    const data = contract.iface.encodeFunctionData(fn, args);
    const r = await this.vm.evm.runCall({ caller: from, to: new Address(hexToBytes(contract.address)), data: hexToBytes(data), gasLimit: 10_000_000n });
    const ret = bytesToHex(r.execResult.returnValue);
    if (r.execResult.exceptionError) {
      let reason = r.execResult.exceptionError.error;
      if (ret.startsWith("0x08c379a0")) reason = abi.decode(["string"], "0x" + ret.slice(10))[0];
      const err = new Error(reason);
      err.raw = ret;
      throw err;
    }
    const fragment = contract.iface.getFunction(fn);
    return fragment.outputs.length ? contract.iface.decodeFunctionResult(fn, ret) : undefined;
  }
}

test("ArbExecutor: flash and own-capital arbitrage against mock pairs", { skip: !solc && "set SOLC_NODE_MODULES to run the EVM test" }, async () => {
  const art = compile();
  const evm = await Evm.create();
  const E18 = 10n ** 18n, E6 = 10n ** 6n;

  const weth = await evm.deploy(art.erc20, ["WETH", 18], ["string", "uint8"]);
  const usdc = await evm.deploy(art.erc20, ["USDC", 6], ["string", "uint8"]);
  // Pool A (Uniswap-style, 0.30%): 100 WETH / 200,000 USDC.  Pool B (Aerodrome-style hook, 0.30%): 50 WETH / 105,000 USDC.
  // Pool C (unknown callback name, 0.25%): 30 WETH / 63,000 USDC.
  const mk = async (t0, t1, feePpm, kind, r0, r1) => {
    const p = await evm.deploy(art.pair, [t0.address, t1.address, feePpm, kind], ["address", "address", "uint256", "uint8"]);
    await evm.call(t0, "mint", [p.address, r0]);
    await evm.call(t1, "mint", [p.address, r1]);
    await evm.call(p, "sync");
    return p;
  };
  const poolA = await mk(weth, usdc, 3000, 0, 100n * E18, 200_000n * E6);
  const poolB = await mk(usdc, weth, 3000, 1, 105_000n * E6, 50n * E18);
  const poolC = await mk(weth, usdc, 2500, 2, 30n * E18, 63_000n * E6);
  const executor = await evm.deploy(art.executor);
  assert.equal((await evm.call(executor, "owner"))[0].toLowerCase(), evm.owner.toString().toLowerCase());

  const reserves = async (p) => {
    const [r0, r1] = await evm.call(p, "getReserves");
    return [r0, r1];
  };
  const asPool = async (p, t0, t1, feePpm, model) => {
    const [r0, r1] = await reserves(p);
    return { address: p.address, token0: t0.address, token1: t1.address, reserve0: r0, reserve1: r1, feePpm, feeModel: model };
  };

  // --- Flash mode: WETH is dear on B (2100) and cheap on A (2000): sell WETH on B, buy back on A.
  let A = await asPool(poolA, weth, usdc, 3000, "ppm");
  let B = await asPool(poolB, usdc, weth, 3000, "bps");
  const q1 = quoteArb(B, A, weth.address); // buy on B with WETH (-> USDC), sell USDC on A (-> WETH)
  assert.ok(q1 && q1.profit > 0n, "route should be profitable");
  const before = (await evm.call(weth, "balanceOf", [executor.address]))[0];
  assert.equal(before, 0n);
  const [profitFlash] = await evm.call(executor, "executeFlash", [q1.buyPool.address, q1.sellPool.address, weth.address, q1.amountIn, q1.amountMid, q1.amountOut, q1.profit]);
  assert.equal(profitFlash, q1.profit, "on-chain profit equals the TypeScript quote to the wei");
  assert.equal((await evm.call(weth, "balanceOf", [executor.address]))[0], q1.profit);
  // Reserves moved exactly as modelled.
  const [a0, a1] = await reserves(poolA);
  assert.equal(a0, A.reserve0 - q1.amountOut);
  assert.equal(a1, A.reserve1 + q1.amountMid);

  // --- Own-capital mode on pool C (unknown callback name is irrelevant here) vs A.
  A = await asPool(poolA, weth, usdc, 3000, "ppm");
  const C = await asPool(poolC, weth, usdc, 2500, "ppm");
  const q2 = quoteArb(C, A, weth.address) ?? quoteArb(A, C, weth.address);
  assert.ok(q2 && q2.profit > 0n, "A/C route should be profitable");
  await evm.call(weth, "mint", [executor.address, q2.amountIn]);
  const balBefore = (await evm.call(weth, "balanceOf", [executor.address]))[0];
  const [profitCap] = await evm.call(executor, "executeWithCapital", [q2.buyPool.address, q2.sellPool.address, weth.address, q2.amountIn, q2.amountMid, q2.amountOut, q2.profit]);
  assert.equal(profitCap, q2.profit);
  assert.equal((await evm.call(weth, "balanceOf", [executor.address]))[0], balBefore + q2.profit);

  // --- Flash mode borrowing from the unknown-callback pool exercises the fallback handler.
  const A2 = await asPool(poolA, weth, usdc, 3000, "ppm");
  const B2 = await asPool(poolB, usdc, weth, 3000, "bps");
  const C2 = await asPool(poolC, weth, usdc, 2500, "ppm");
  // Find any profitable route that borrows from (sells on) C.
  const q3 = quoteArb(A2, C2, weth.address) ?? quoteArb(B2, C2, weth.address) ?? quoteArb(A2, C2, usdc.address) ?? quoteArb(B2, C2, usdc.address);
  assert.ok(q3, "expected a route that borrows from pool C (fallback callback)");
  {
    const tok = q3.tokenIn.toLowerCase() === weth.address.toLowerCase() ? weth : usdc;
    const b0 = (await evm.call(tok, "balanceOf", [executor.address]))[0];
    const [p3] = await evm.call(executor, "executeFlash", [q3.buyPool.address, q3.sellPool.address, q3.tokenIn, q3.amountIn, q3.amountMid, q3.amountOut, 1n]);
    assert.equal(p3, q3.profit);
    assert.equal((await evm.call(tok, "balanceOf", [executor.address]))[0], b0 + q3.profit);
  }

  // --- simulate() reverts with the profit (string-encoded in the 0.7 build).
  // Re-open a spread first: a large USDC buy lands in pool B.
  await evm.call(usdc, "mint", [poolB.address, 8_000n * E6]);
  await evm.call(poolB, "sync");
  const A3 = await asPool(poolA, weth, usdc, 3000, "ppm");
  const B3 = await asPool(poolB, usdc, weth, 3000, "bps");
  const q4 = quoteArb(A3, B3, weth.address) ?? quoteArb(B3, A3, weth.address) ?? quoteArb(A3, B3, usdc.address) ?? quoteArb(B3, A3, usdc.address);
  assert.ok(q4, "expected a route for simulate()");
  {
    await assert.rejects(
      evm.call(executor, "simulate", [q4.buyPool.address, q4.sellPool.address, q4.tokenIn, q4.amountIn, q4.amountMid, q4.amountOut, true], { from: evm.stranger }),
      (err) => {
        assert.equal(err.raw.length, 2 + 64, "simulate must revert with exactly 32 bytes (the profit)");
        assert.equal(BigInt(err.raw), q4.profit);
        return true;
      },
    );
  }

  // --- Safety rails.
  await assert.rejects(evm.call(executor, "executeFlash", [q1.buyPool.address, q1.sellPool.address, weth.address, q1.amountIn, q1.amountMid, q1.amountOut, 1n], { from: evm.stranger }), /NotOwner/);
  // Stale quote (route already taken): the K check in the pool or the profit check must revert, never lose funds.
  const balPre = (await evm.call(weth, "balanceOf", [executor.address]))[0];
  await assert.rejects(evm.call(executor, "executeFlash", [q1.buyPool.address, q1.sellPool.address, weth.address, q1.amountIn, q1.amountMid, q1.amountOut, 1n]));
  assert.equal((await evm.call(weth, "balanceOf", [executor.address]))[0], balPre, "no funds lost on a failed attempt");
  // Direct callback from a random address is rejected.
  await assert.rejects(evm.call(executor, "uniswapV2Call", [executor.address, 0n, 0n, "0x"], { from: evm.stranger }), /BadCallback/);
  // Withdraw works for the owner only.
  await assert.rejects(evm.call(executor, "withdraw", [weth.address, 0n], { from: evm.stranger }), /NotOwner/);
  await evm.call(executor, "withdraw", [weth.address, 0n]);
  assert.equal((await evm.call(weth, "balanceOf", [executor.address]))[0], 0n);
  assert.equal((await evm.call(weth, "balanceOf", [evm.owner.toString()]))[0], balPre);
});

test("state-override simulation bytecode reverts with Simulated(profit) exactly like the 0.8 ABI", { skip: !solc && "set SOLC_NODE_MODULES to run the EVM test" }, async () => {
  const art = compile();
  const evm = await Evm.create();
  const E18 = 10n ** 18n, E6 = 10n ** 6n;
  const weth = await evm.deploy(art.erc20, ["WETH", 18], ["string", "uint8"]);
  const usdc = await evm.deploy(art.erc20, ["USDC", 6], ["string", "uint8"]);
  const mk = async (t0, t1, feePpm, kind, r0, r1) => {
    const p = await evm.deploy(art.pair, [t0.address, t1.address, feePpm, kind], ["address", "address", "uint256", "uint8"]);
    await evm.call(t0, "mint", [p.address, r0]);
    await evm.call(t1, "mint", [p.address, r1]);
    await evm.call(p, "sync");
    return p;
  };
  const poolA = await mk(weth, usdc, 3000, 0, 100n * E18, 200_000n * E6);
  const poolB = await mk(usdc, weth, 3000, 1, 105_000n * E6, 50n * E18);
  const [a0, a1] = await evm.call(poolA, "getReserves");
  const [b0, b1] = await evm.call(poolB, "getReserves");
  const A = { address: poolA.address, token0: weth.address, token1: usdc.address, reserve0: a0, reserve1: a1, feePpm: 3000, feeModel: "ppm" };
  const B = { address: poolB.address, token0: usdc.address, token1: weth.address, reserve0: b0, reserve1: b1, feePpm: 3000, feeModel: "bps" };
  const q = quoteArb(B, A, weth.address);
  assert.ok(q && q.profit > 0n);

  // Inject the generated runtime code at an address that has no contract (what eth_call state overrides do).
  const fake = "0x00000000000000000000000000000000a4b17e51";
  await evm.injectCode(fake, SIM_EXECUTOR_RUNTIME);
  const sim = { address: fake, iface: executorIface };
  await assert.rejects(
    evm.call(sim, "simulate", [q.buyPool.address, q.sellPool.address, weth.address, q.amountIn, q.amountMid, q.amountOut, true], { from: evm.stranger }),
    (err) => {
      const parsed = executorIface.parseError(err.raw);
      assert.ok(parsed && parsed.name === "Simulated", `expected Simulated(), got ${err.raw.slice(0, 20)}`);
      assert.equal(parsed.args[0], q.profit, "simulated profit equals the local quote to the wei");
      return true;
    },
  );
  // A stale/impossible route reverts with something that is NOT Simulated (here InsufficientProfit).
  await assert.rejects(
    evm.call(sim, "simulate", [q.buyPool.address, q.sellPool.address, weth.address, q.amountIn * 3n, q.amountMid * 3n, q.amountOut * 3n, true], { from: evm.stranger }),
    (err) => {
      const parsed = (() => { try { return executorIface.parseError(err.raw); } catch { return null; } })();
      assert.ok(!parsed || parsed.name !== "Simulated");
      return true;
    },
  );
});
