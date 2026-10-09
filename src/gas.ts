/**
 * Transaction cost estimation for Base: L2 execution fee plus the L1 data fee
 * charged through the GasPriceOracle predeploy.
 */
import { GAS_PRICE_ORACLE } from "./config.js";
import { gasOracleIface, executorIface } from "./abi.js";
import type { Chain } from "./rpc.js";
import { blocksFor } from "./blocktime.js";
import { log } from "./log.js";

export interface GasQuote {
  block: number;
  baseFeeWei: bigint;
  priorityFeeWei: bigint;
  gasLimit: number;
  l2FeeWei: bigint;
  l1FeeWei: bigint;
  totalWei: bigint;
}

/** A representative executeFlash() calldata plus signature overhead, used to size the L1 data fee. */
function representativeTxBytes(): string {
  const data = executorIface.encodeFunctionData("executeFlash", [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x4200000000000000000000000000000000000006",
    123456789012345678n,
    987654321098765432n,
    123456789012345678n,
    1000000000000000n,
  ]);
  // ~110 bytes of RLP framing, nonce, gas fields and a 65-byte signature.
  const overhead = "ab".repeat(110);
  return data + overhead;
}

export class GasEstimator {
  private cache: GasQuote | undefined;

  constructor(readonly chain: Chain, readonly gasLimit: number, readonly priorityFeeGwei: number) {}

  private l1Cache: { block: number; fee: bigint } | undefined;
  /** The L1 data fee moves slowly; refresh it roughly every 20s to save RPC budget (derived from block time, so Denim-safe). */
  l1RefreshBlocks = blocksFor(20_000);

  /** Quote is computed once per block and reused for every candidate in that block. */
  async quote(block: number, baseFeeWei: bigint | null): Promise<GasQuote> {
    if (this.cache && this.cache.block === block) return this.cache;
    let baseFee = baseFeeWei;
    if (baseFee === null) {
      const b = await this.chain.getBlock(block);
      baseFee = b?.baseFeePerGas ?? 10_000_000n; // 0.01 gwei fallback
    }
    const priority = BigInt(Math.round(this.priorityFeeGwei * 1e9));
    let l1Fee = this.l1Cache?.fee ?? 0n;
    if (!this.l1Cache || block - this.l1Cache.block >= this.l1RefreshBlocks) {
      try {
        const raw = await this.chain.call(GAS_PRICE_ORACLE, gasOracleIface.encodeFunctionData("getL1Fee", [representativeTxBytes()]), block);
        l1Fee = gasOracleIface.decodeFunctionResult("getL1Fee", raw)[0] as bigint;
        this.l1Cache = { block, fee: l1Fee };
      } catch (err) {
        log.warn("getL1Fee failed; using last known L1 data fee:", (err as Error).message.slice(0, 120));
      }
    }
    const l2Fee = BigInt(this.gasLimit) * (baseFee + priority);
    this.cache = {
      block,
      baseFeeWei: baseFee,
      priorityFeeWei: priority,
      gasLimit: this.gasLimit,
      l2FeeWei: l2Fee,
      l1FeeWei: l1Fee,
      totalWei: l2Fee + l1Fee,
    };
    return this.cache;
  }
}

export function weiToUsd(wei: bigint, ethUsd: number): number {
  return (Number(wei) / 1e18) * ethUsd;
}
