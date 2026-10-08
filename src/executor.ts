/**
 * Live execution through the ArbExecutor contract. Only used when MODE=live.
 *
 * Safety rails:
 *   - one transaction in flight at a time (no nonce races, no double-spend of a
 *     single opportunity)
 *   - the on-chain minProfit check makes a losing trade revert; we still pay
 *     gas for the revert, which is why paper mode comes first
 *   - a file named STOP in the data directory halts sending immediately
 *   - a daily gas budget (MAX_DAILY_GAS_USD) stops the bot if reverts pile up
 */
import { Wallet, type TransactionResponse } from "ethers";
import { executorIface } from "./abi.js";
import type { Chain } from "./rpc.js";
import type { Opportunity } from "./scanner.js";
import type { Store } from "./store.js";
import { log } from "./log.js";

export interface LiveRecord {
  kind: "live";
  id: string;
  block: number;
  sentAt: string;
  txHash: string;
  status: "pending" | "success" | "reverted" | "dropped";
  gasUsedWei?: bigint;
  minedBlock?: number;
  expectedProfitUsd: number;
}

export class LiveExecutor {
  private inFlight: Promise<void> | null = null;
  private gasSpentTodayUsd = 0;
  private day = "";
  readonly wallet: Wallet;

  constructor(
    readonly chain: Chain,
    readonly store: Store,
    privateKey: string,
    readonly executorAddress: string,
    readonly opts: { gasLimit: number; priorityFeeGwei: number; maxDailyGasUsd: number; useFlash: boolean },
  ) {
    this.wallet = new Wallet(privateKey, chain.provider);
  }

  get busy(): boolean {
    return this.inFlight !== null;
  }

  private stopped(): boolean {
    return this.store.exists("STOP");
  }

  /** Fire-and-track. Returns false if the opportunity was not sent. */
  trySend(o: Opportunity, ethUsd: number): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.gasSpentTodayUsd = 0;
    }
    if (this.stopped()) {
      log.warn("STOP file present; not sending");
      return false;
    }
    if (this.inFlight) return false;
    if (this.gasSpentTodayUsd > this.opts.maxDailyGasUsd) {
      log.warn(`daily gas budget exhausted ($${this.gasSpentTodayUsd.toFixed(2)}); not sending`);
      return false;
    }
    if (o.route) {
      // Multi-hop / CL routes need RouteExecutor and stay paper-only for now;
      // never send them through the two-pool ArbExecutor.
      log.debug(`not sending ${o.id}: multi-hop routes are paper-only`);
      return false;
    }
    if (o.sim !== "executor-ok") {
      log.warn(`refusing to send ${o.id}: simulation state is ${o.sim} (${o.simDetail ?? ""})`);
      return false;
    }
    this.inFlight = this.send(o, ethUsd).finally(() => {
      this.inFlight = null;
    });
    return true;
  }

  private async send(o: Opportunity, ethUsd: number): Promise<void> {
    // Give up 5% of the modelled profit to reserve slack for reserve drift within the block.
    const minProfit = (o.profit * 95n) / 100n;
    const fn = this.opts.useFlash ? "executeFlash" : "executeWithCapital";
    const data = executorIface.encodeFunctionData(fn, [o.buyPool, o.sellPool, o.tokenIn, o.amountIn, o.amountMid, o.amountOut, minProfit]);
    const fee = await this.chain.provider.getFeeData();
    const priority = BigInt(Math.round(this.opts.priorityFeeGwei * 1e9));
    const base = fee.maxFeePerGas ?? (fee.gasPrice ?? 0n);
    let tx: TransactionResponse;
    try {
      tx = await this.wallet.sendTransaction({
        to: this.executorAddress,
        data,
        gasLimit: this.opts.gasLimit,
        maxPriorityFeePerGas: priority,
        maxFeePerGas: base + priority,
        type: 2,
      });
    } catch (err) {
      log.error("send failed:", (err as Error).message.slice(0, 200));
      return;
    }
    const rec: LiveRecord = { kind: "live", id: o.id, block: o.block, sentAt: new Date().toISOString(), txHash: tx.hash, status: "pending", expectedProfitUsd: o.netUsd };
    this.store.append("live.jsonl", rec);
    log.info(`live: sent ${tx.hash} for ${o.pairSymbols} expecting net $${o.netUsd.toFixed(3)}`);
    try {
      const receipt = await tx.wait(1, 60_000);
      if (!receipt) {
        this.store.append("live.jsonl", { ...rec, status: "dropped" });
        return;
      }
      const gasWei = receipt.gasUsed * (receipt.gasPrice ?? 0n);
      const gasUsd = (Number(gasWei) / 1e18) * ethUsd;
      this.gasSpentTodayUsd += gasUsd;
      const status = receipt.status === 1 ? "success" : "reverted";
      this.store.append("live.jsonl", { ...rec, status, gasUsedWei: gasWei, minedBlock: receipt.blockNumber });
      log[status === "success" ? "info" : "warn"](`live: ${tx.hash} ${status} in block ${receipt.blockNumber}, gas $${gasUsd.toFixed(3)}`);
    } catch (err) {
      log.warn("live: wait failed:", (err as Error).message.slice(0, 160));
      this.store.append("live.jsonl", { ...rec, status: "dropped" });
    }
  }
}
