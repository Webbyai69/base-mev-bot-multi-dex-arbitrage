/**
 * `check` command: verifies the RPC works and that every configured address
 * answers like the contract we think it is. Run this first on a new machine.
 */
import { AbiCoder } from "ethers";
import { CHAIN_ID, DEXES, GAS_PRICE_ORACLE, MULTICALL3, TOKENS } from "./config.js";
import { aeroFactoryIface, erc20Iface, gasOracleIface, multicall3Iface, univ2FactoryIface } from "./abi.js";
import type { Chain, Call } from "./rpc.js";
import { log } from "./log.js";

const abi = AbiCoder.defaultAbiCoder();

export async function runCheck(chain: Chain): Promise<boolean> {
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
  return ok;
}
