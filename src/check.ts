/**
 * `check` command: verifies the RPC works and that every configured address
 * answers like the contract we think it is. Run this first on a new machine.
 */
import { AbiCoder } from "ethers";
import { AAVE_V3, BALANCER_FEES_COLLECTOR, CHAIN_ID, CL_DEXES, DEXES, GAS_PRICE_ORACLE, MORPHO_BLUE, MULTICALL3, TOKENS, USDC, WETH } from "./config.js";
import {
  aavePoolIface,
  aeroFactoryIface,
  erc20Iface,
  gasOracleIface,
  multicall3Iface,
  slipstreamFactoryIface,
  slipstreamQuoterIface,
  univ2FactoryIface,
  univ3FactoryIface,
  univ3QuoterIface,
} from "./abi.js";
import type { Chain, Call } from "./rpc.js";
import { log } from "./log.js";

const abi = AbiCoder.defaultAbiCoder();

/** Which of the upgrade's contracts to verify (all by default; tests against the V2-only mock chain turn them off). */
export interface CheckOptions {
  clPools?: boolean;
  flashLoans?: boolean;
  liquidations?: boolean;
}

export async function runCheck(chain: Chain, opts: CheckOptions = {}): Promise<boolean> {
  let ok = true;
  const net = await chain.provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    log.error(`RPC reports chain id ${net.chainId}, expected ${CHAIN_ID} (Base mainnet)`);
    return false;
  }
  const block = await chain.blockNumber();
  log.info(`RPC ok — Base mainnet, block ${block}`);

  // Multicall3 itself
  try {
    const raw = await chain.call(MULTICALL3, multicall3Iface.encodeFunctionData("getBlockNumber"));
    log.info(`Multicall3 ok (block ${abi.decode(["uint256"], raw)[0]})`);
  } catch (err) {
    log.error("Multicall3 not responding:", (err as Error).message);
    return false;
  }

  const calls: Call[] = [];
  const labels: string[] = [];
  for (const d of DEXES) {
    calls.push({
      target: d.factory,
      callData: d.kind === "aerodrome" ? aeroFactoryIface.encodeFunctionData("allPoolsLength") : univ2FactoryIface.encodeFunctionData("allPairsLength"),
    });
    labels.push(`${d.name} factory ${d.factory}`);
  }
  for (const t of Object.values(TOKENS)) {
    calls.push({ target: t.address, callData: erc20Iface.encodeFunctionData("symbol") });
    labels.push(`token ${t.symbol} ${t.address}`);
  }
  calls.push({ target: GAS_PRICE_ORACLE, callData: gasOracleIface.encodeFunctionData("l1BaseFee") });
  labels.push(`GasPriceOracle ${GAS_PRICE_ORACLE}`);

  const res = await chain.multicall(calls);
  res.forEach((r, i) => {
    const label = labels[i]!;
    if (!r.success || r.returnData.length < 66) {
      log.error(`FAIL ${label}: no valid response — check the address on basescan.org`);
      ok = false;
      return;
    }
    if (label.startsWith("token")) {
      let sym = "?";
      try {
        sym = abi.decode(["string"], r.returnData)[0] as string;
      } catch {
        sym = "(bytes32 symbol)";
      }
      const expected = label.split(" ")[1];
      if (sym !== expected) {
        log.error(`FAIL ${label}: on-chain symbol is ${sym}`);
        ok = false;
      } else log.info(`ok   ${label} -> ${sym}`);
    } else {
      const n = abi.decode(["uint256"], r.returnData)[0] as bigint;
      log.info(`ok   ${label} -> ${n}`);
    }
  });
  return (await runUpgradeChecks(chain, { clPools: opts.clPools ?? true, flashLoans: opts.flashLoans ?? true, liquidations: opts.liquidations ?? true })) && ok;
}

/**
 * Addresses added by the V3 / multi-hop / liquidation upgrade. For each CL
 * DEX: the factory must know a WETH/USDC pool and the quoter must price
 * 0.01 WETH through it. Plus Morpho (free flash loans need idle WETH),
 * Balancer's flash-loan fee, and Aave V3's reserve list.
 */
async function runUpgradeChecks(chain: Chain, opts: Required<CheckOptions>): Promise<boolean> {
  let ok = true;
  const ZERO = "0x0000000000000000000000000000000000000000";
  for (const d of opts.clPools ? CL_DEXES : []) {
    const calls: Call[] = d.poolKeys.map((k) => ({
      target: d.factory,
      callData: d.kind === "univ3" ? univ3FactoryIface.encodeFunctionData("getPool", [WETH, USDC, k]) : slipstreamFactoryIface.encodeFunctionData("getPool", [WETH, USDC, k]),
    }));
    const res = await chain.multicall(calls);
    const found = res
      .map((r, i) => ({ key: d.poolKeys[i]!, pool: r.success && r.returnData.length >= 66 ? (abi.decode(["address"], r.returnData)[0] as string) : ZERO }))
      .filter((x) => x.pool !== ZERO);
    if (found.length === 0) {
      if (res.every((r) => !r.success)) {
        log.error(`FAIL ${d.name} factory ${d.factory}: getPool() does not answer — check the address`);
        ok = false;
      } else log.warn(`NOTE ${d.name} factory ${d.factory} answers but has no WETH/USDC pool; its quoter was not tested`);
      continue;
    }
    const { key, pool } = found[0]!;
    const amountIn = 10n ** 16n;
    const callData =
      d.kind === "univ3"
        ? univ3QuoterIface.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: WETH, tokenOut: USDC, amountIn, fee: key, sqrtPriceLimitX96: 0n }])
        : slipstreamQuoterIface.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: WETH, tokenOut: USDC, amountIn, tickSpacing: key, sqrtPriceLimitX96: 0n }]);
    const [q] = await chain.multicall([{ target: d.quoter, callData }]);
    if (!q || !q.success || q.returnData.length < 66) {
      log.error(`FAIL ${d.name} quoter ${d.quoter}: could not quote WETH->USDC through ${pool}`);
      ok = false;
      continue;
    }
    const out = abi.decode(["uint256"], q.returnData.slice(0, 66))[0] as bigint;
    log.info(`ok   ${d.name}: ${found.length} WETH/USDC pools, quoter says 0.01 WETH -> ${(Number(out) / 1e6).toFixed(2)} USDC`);
  }
  if (!opts.flashLoans && !opts.liquidations) return ok;
  const res = await chain.multicall([
    { target: WETH, callData: erc20Iface.encodeFunctionData("balanceOf", [MORPHO_BLUE]) },
    { target: BALANCER_FEES_COLLECTOR, callData: "0xd877845c" }, // getFlashLoanFeePercentage()
    { target: AAVE_V3.pool, callData: aavePoolIface.encodeFunctionData("getReservesList") },
  ]);
  const [morpho, bal, aave] = res;
  if (!opts.flashLoans) {
    /* skipped */
  } else if (morpho?.success && morpho.returnData.length >= 66) log.info(`ok   Morpho Blue ${MORPHO_BLUE}: ${(Number(abi.decode(["uint256"], morpho.returnData)[0]) / 1e18).toFixed(1)} WETH available for free flash loans`);
  else {
    log.error(`FAIL Morpho Blue ${MORPHO_BLUE}: WETH balance unreadable`);
    ok = false;
  }
  if (!opts.flashLoans) {
    /* skipped */
  } else if (bal?.success && bal.returnData.length >= 66) {
    const fee = abi.decode(["uint256"], bal.returnData)[0] as bigint;
    log[fee === 0n ? "info" : "warn"](`${fee === 0n ? "ok  " : "NOTE"} Balancer V2 flash-loan fee: ${(Number(fee) / 1e16).toFixed(4)}%${fee === 0n ? "" : " — prefer FLASH_SOURCE=morpho"}`);
  } else log.warn(`NOTE Balancer fee collector ${BALANCER_FEES_COLLECTOR}: could not read the flash-loan fee (only matters with FLASH_SOURCE=balancer)`);
  if (!opts.liquidations) {
    /* skipped */
  } else if (aave?.success && aave.returnData.length > 66) {
    const list = aavePoolIface.decodeFunctionResult("getReservesList", aave.returnData)[0] as string[];
    log.info(`ok   Aave V3 pool ${AAVE_V3.pool}: ${list.length} reserves`);
  } else {
    log.error(`FAIL Aave V3 pool ${AAVE_V3.pool}: getReservesList failed (set LIQUIDATIONS=false to skip)`);
    ok = false;
  }
  return ok;
}
