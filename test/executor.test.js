/**
 * The live trading path end to end, on a real EVM node (Foundry's anvil):
 *
 *   your wallet deploys the exact ArbExecutor bytecode the dashboard sends,
 *   authorises a separate bot wallet, the readiness check gates sending,
 *   the state-override simulation agrees with the TypeScript quote to the wei,
 *   LiveExecutor sends a real flash-swap arbitrage that lands its profit in the
 *   contract, a stale resend is recorded as "reverted" with its gas counted,
 *   only the owner can withdraw, and revoking the bot wallet blocks sending.
 *
 * Optional: needs Foundry's anvil and a solc 0.8.26 binary (for the mock pools).
 *   ANVIL=/path/to/anvil SOLC=/path/to/solc npm test
 * Skipped otherwise. The contract itself is also covered by `forge test`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFactory, Contract, JsonRpcProvider, Network, Wallet, ZeroAddress } from "ethers";
import { quoteArb } from "../dist/math.js";
import { executorIface } from "../dist/abi.js";
import { Chain } from "../dist/rpc.js";
import { Store } from "../dist/store.js";
import { LiveExecutor, checkLiveSetup, pickLiveOpportunity } from "../dist/executor.js";
import { SIM_EXECUTOR_RUNTIME } from "../dist/simBytecode.js";
import { ARB_EXECUTOR_CREATION } from "../dist/deployBytecode.js";

const ANVIL = process.env.ANVIL;
const SOLC = process.env.SOLC;
const skip = !(ANVIL && SOLC && existsSync(ANVIL) && existsSync(SOLC)) && "set ANVIL and SOLC to run the live-path EVM test";
const root = fileURLToPath(new URL("..", import.meta.url));

let node;
after(() => node?.kill());

async function startAnvil() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  node = spawn(ANVIL, ["--port", String(port), "--chain-id", "8453", "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  // cacheTimeout -1: ethers otherwise reuses a 250 ms-old nonce for back-to-back deployments.
  const provider = new JsonRpcProvider(url, 8453, { staticNetwork: Network.from(8453), cacheTimeout: -1 });
  for (let i = 0; i < 100; i++) {
    try {
      await provider.getBlockNumber();
      return { url, provider };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

function compileMocks() {
  const input = {
    language: "Solidity",
    sources: { "Mocks.sol": { content: readFileSync(join(root, "test", "contracts", "Mocks.sol"), "utf8") } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(execFileSync(SOLC, ["--standard-json"], { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 64 << 20 }));
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const get = (name) => ({ abi: out.contracts["Mocks.sol"][name].abi, bytecode: "0x" + out.contracts["Mocks.sol"][name].evm.bytecode.object });
  return { erc20: get("MockERC20"), pair: get("MockPair") };
}

const waitIdle = async (live) => {
  for (let i = 0; i < 200 && live.busy; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(live.busy, false, "send finished");
};

test("live path: deploy from your wallet, authorise the bot wallet, trade, withdraw", { skip }, async () => {
  const { url, provider } = await startAnvil();
  const fund = (addr, eth) => provider.send("anvil_setBalance", [addr, "0x" + (BigInt(Math.round(eth * 1e6)) * 10n ** 12n).toString(16)]);
  // Fresh random wallets: "you" (the owner, e.g. Brave) and the bot's own wallet.
  const owner = Wallet.createRandom().connect(provider);
  const botKey = Wallet.createRandom();
  await fund(owner.address, 10);

  const art = compileMocks();
  const E18 = 10n ** 18n;
  const E6 = 10n ** 6n;
  const deploy = async (a, ...args) => {
    const c = await new ContractFactory(a.abi, a.bytecode, owner).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const weth = await deploy(art.erc20, "WETH", 18);
  const usdc = await deploy(art.erc20, "USDC", 6);
  const mk = async (t0, t1, feePpm, kind, r0, r1) => {
    const p = await deploy(art.pair, await t0.getAddress(), await t1.getAddress(), feePpm, kind);
    await (await t0.mint(await p.getAddress(), r0)).wait();
    await (await t1.mint(await p.getAddress(), r1)).wait();
    await (await p.sync()).wait();
    return p;
  };
  // A: Uniswap-style 0.30%, WETH at 2,000. B: Aerodrome-style `hook` callback, WETH at 2,100.
  const poolA = await mk(weth, usdc, 3000, 0, 100n * E18, 200_000n * E6);
  const poolB = await mk(usdc, weth, 3000, 1, 105_000n * E6, 50n * E18);
  const W = (await weth.getAddress()).toLowerCase();
  const U = (await usdc.getAddress()).toLowerCase();

  // 1. Your wallet deploys the exact creation bytecode the dashboard's Deploy button sends.
  const deployTx = await owner.sendTransaction({ data: ARB_EXECUTOR_CREATION });
  const exec = (await deployTx.wait()).contractAddress;
  assert.ok(exec, "deployed");
  const execC = new Contract(exec, executorIface, owner);
  assert.equal((await execC.owner()).toLowerCase(), owner.address.toLowerCase(), "your wallet owns it");

  const chain = new Chain(url);
  try {
    // 2. Readiness check: not authorised and no gas yet -> blocked, with both reasons spelled out.
    let c = await checkLiveSetup(chain, exec, botKey.address, 260_000, 0.005);
    assert.equal(c.ok, false);
    assert.equal(c.codeMatches, true, "on-chain code is exactly this version's ArbExecutor");
    assert.ok(c.problems.some((p) => /isn't authorised/.test(p)), c.problems.join(" | "));
    assert.ok(c.problems.some((p) => /not enough for gas/.test(p)), c.problems.join(" | "));
    // A wrong EXECUTOR_ADDRESS is caught too.
    const wrong = await checkLiveSetup(chain, await weth.getAddress(), botKey.address, 260_000, 0.005);
    assert.ok(wrong.problems.some((p) => /isn't this version's ArbExecutor/.test(p)));
    const empty = await checkLiveSetup(chain, Wallet.createRandom().address, botKey.address, 260_000, 0.005);
    assert.ok(empty.problems.some((p) => /no contract/.test(p)));

    // 3. Authorise the bot wallet and top it up (the dashboard's two other buttons).
    await (await execC.setOperator(botKey.address)).wait();
    await (await owner.sendTransaction({ to: botKey.address, value: 10n ** 16n })).wait();
    c = await checkLiveSetup(chain, exec, botKey.address, 260_000, 0.005);
    assert.deepEqual(c.problems, []);
    assert.equal(c.operator, botKey.address.toLowerCase());

    // 4. The state-override simulation (paper mode's check) agrees with the quote to the wei.
    const state = async (p, t0, t1, model) => {
      const [r0, r1] = await p.getReserves();
      return { address: (await p.getAddress()).toLowerCase(), token0: t0, token1: t1, reserve0: r0, reserve1: r1, feePpm: 3000, feeModel: model };
    };
    const A = await state(poolA, W, U, "ppm");
    const B = await state(poolB, U, W, "bps");
    const q = quoteArb(B, A, W); // sell WETH into B (dear), buy it back on A (cheap)
    assert.ok(q && q.profit > 0n, "profitable route");
    const fake = "0x00000000000000000000000000000000a4b17e51";
    const simData = executorIface.encodeFunctionData("simulate", [q.buyPool.address, q.sellPool.address, W, q.amountIn, q.amountMid, q.amountOut, true]);
    await assert.rejects(chain.callWithOverrides(fake, simData, "latest", { [fake]: { code: SIM_EXECUTOR_RUNTIME } }), (err) => {
      const data = err.data ?? err.error?.data ?? err.info?.error?.data;
      const parsed = executorIface.parseError(data);
      assert.equal(parsed?.name, "Simulated");
      assert.equal(parsed.args[0], q.profit, "simulated profit equals the local quote to the wei");
      return true;
    });

    // 5. LiveExecutor: blocked until verify() passes, then sends the best eligible find.
    const store = new Store(mkdtempSync(join(tmpdir(), "live-")));
    const live = new LiveExecutor(chain, store, botKey.privateKey, exec, { gasLimit: 260_000, priorityFeeGwei: 0.005, maxDailyGasUsd: 1, useFlash: true, maxConsecutiveFailures: 5 });
    const opp = {
      id: "o1", block: await provider.getBlockNumber(), foundAt: new Date().toISOString(), pair: "WETH/USDC", pairSymbols: "WETH/USDC",
      buyPool: q.buyPool.address, buyDex: "aerodrome", sellPool: q.sellPool.address, sellDex: "uniswap-v2", tokenIn: W, tokenInSymbol: "WETH", tokenMid: U,
      amountIn: q.amountIn, amountMid: q.amountMid, amountOut: q.amountOut, profit: q.profit, profitUsd: 5, gasUsd: 0.01, netUsd: 4.99, sim: "executor-ok", hops: 2,
    };
    assert.equal(live.trySend(opp, 2000), false, "nothing is sent before the setup check has passed");
    await live.verify();
    assert.equal(live.blocked, null);
    // A route or an unverified find is never picked, even when it looks better.
    const route = { ...opp, id: "r1", netUsd: 50, route: { tokens: [], pools: [], dexes: [], amounts: [], label: "x" } };
    const unverified = { ...opp, id: "u1", netUsd: 40, sim: "executor-revert" };
    assert.equal(pickLiveOpportunity([route, unverified, opp]).id, "o1");

    assert.equal(live.trySend(opp, 2000), true);
    await waitIdle(live);
    const records = () => readFileSync(store.path("live.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    let last = records().at(-1);
    assert.equal(last.status, "success", JSON.stringify(last));
    assert.equal(await weth.balanceOf(exec), q.profit, "the profit sits in your contract");
    assert.equal(await weth.balanceOf(botKey.address), 0n, "nothing goes to the bot wallet");
    assert.equal(live.safety.succeeded, 1);

    // 6. The same trade again is stale: recorded as reverted (not dropped), and its gas counted.
    const gasBefore = live.safety.gasSpentTodayUsd;
    assert.equal(live.trySend(opp, 2000), true);
    await waitIdle(live);
    last = records().at(-1);
    assert.equal(last.status, "reverted", JSON.stringify(last));
    assert.equal(live.safety.consecutiveFailures, 1);
    assert.ok(live.safety.gasSpentTodayUsd > gasBefore, "gas of the reverted attempt counts toward the daily limit");
    assert.equal(await weth.balanceOf(exec), q.profit, "a failed attempt costs gas, never the profit");

    // 7. Only your wallet can withdraw; the bot wallet can't.
    const asBot = new Contract(exec, executorIface, botKey.connect(provider));
    await assert.rejects(asBot.withdraw.staticCall(W, 0n), (err) => executorIface.parseError(err.data)?.name === "NotOwner");
    await (await execC.withdraw(W, 0n)).wait();
    assert.equal(await weth.balanceOf(owner.address), q.profit, "profit withdrawn to your wallet");
    assert.equal(await weth.balanceOf(exec), 0n);

    // 8. Revoking the bot wallet blocks sending at the next check.
    await (await execC.setOperator(ZeroAddress)).wait();
    await live.verify();
    assert.match(live.blocked ?? "", /isn't authorised/);
    assert.equal(live.trySend(opp, 2000), false);
    live.stopChecks();
  } finally {
    await chain.destroy();
  }
});
